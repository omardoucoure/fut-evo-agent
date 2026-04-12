/**
 * POST /api/agent/chat
 *
 * AI agent conversation endpoint powered by OpenAI with tool calling.
 * Supports tool calling, conversation history, and persistent user context.
 *
 * Body:
 * - message: string (user's question)
 * - conversationHistory: array (previous messages)
 * - context: AgentContext (optional, inline context override)
 * - sessionId: string (optional, for persisting interactions)
 * - subscriptionId: number (optional, for loading saved context)
 *
 * Returns:
 * - success: boolean
 * - response: string (agent response)
 * - toolsUsed: string[] (names of tools invoked)
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runAgent, AgentContext } from '@/lib/agent/agent';
import { createClient } from '@/lib/database/client';
import { validateMobileApiKey } from '@/lib/push/auth';

function getDb() {
  return createClient();
}

export async function POST(request: NextRequest) {
  const authError = validateMobileApiKey(request);
  if (authError) return authError;
  try {
    const body = await request.json();
    const { message, conversationHistory = [], context, subscriptionId } = body;
    const sessionId = body.sessionId || `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error('[Agent Chat] OPENAI_API_KEY not configured');
      return NextResponse.json({ error: 'AI service not configured' }, { status: 500 });
    }

    // Limit conversation history to the last 6 messages to keep token count low
    const recentHistory = conversationHistory.slice(-6);

    console.log(`[Agent Chat] Session: ${sessionId || 'anonymous'}, Message: "${message.substring(0, 80)}...", History: ${conversationHistory.length} msgs (using last ${recentHistory.length})`);

    // Load or build context — always ensure preferences is an object to avoid Object.keys(null) crashes
    const agentContext: AgentContext = {
      platform: context?.platform || 'ps',
      budget: context?.budget || 0,
      squadSummary: context?.squadSummary || '',
      formation: context?.formation || '',
      preferences: context?.preferences || {},
    };

    // If subscriptionId provided, try to load saved context
    if (subscriptionId && !context) {
      const { data: savedCtx } = await getDb()
        .from('user_agent_contexts')
        .select('*')
        .eq('push_subscription_id', subscriptionId)
        .maybeSingle();

      if (savedCtx) {
        agentContext.platform = savedCtx.platform || 'ps';
        agentContext.budget = savedCtx.budget || 0;
        agentContext.formation = savedCtx.squad_snapshot?.formation || '';
        agentContext.squadSummary = savedCtx.squad_snapshot?.summary || '';
        agentContext.preferences = savedCtx.preferences || {};
      }
    }

    // Run the agent
    const t0 = Date.now();
    const result = await runAgent(message, recentHistory, agentContext);
    const t1 = Date.now();
    console.log(`[Agent Chat] Completed in ${t1 - t0}ms | Tools: ${result.toolCalls.map(t => t.toolName).join(', ') || 'none'} | Response: ${result.response.substring(0, 100)}...`);

    // Save interaction to database
    const db = getDb();
    try {
      await db.from('agent_interactions').insert({
        push_subscription_id: subscriptionId || null,
        session_id: sessionId,
        role: 'user',
        content: message,
      });

      await db.from('agent_interactions').insert({
        push_subscription_id: subscriptionId || null,
        session_id: sessionId,
        role: 'assistant',
        content: result.response,
        tool_calls: result.toolCalls.length > 0 ? result.toolCalls : null,
        model: agentContext.preferences?.thinkingMode === 'deep' ? 'o4-mini' : (process.env.FINE_TUNED_MODEL || 'gpt-4o'),
      });
    } catch (dbErr: any) {
      console.error('[Agent Chat] Failed to save interaction:', dbErr?.message);
    }

    return NextResponse.json({
      success: true,
      response: result.response,
      toolsUsed: result.toolCalls.map((t) => t.toolName),
    });
  } catch (error: any) {
    console.error('[Agent Chat] Error:', error?.message || error, error?.stack?.split('\n').slice(0, 3).join('\n'));
    return NextResponse.json(
      { success: false, response: '', error: 'Failed to get agent response', message: error.message },
      { status: 500 }
    );
  }
}
