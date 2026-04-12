/**
 * POST /api/agent/chat/stream
 *
 * Streaming version of the AI coach chat endpoint.
 * Returns SSE (text/event-stream) with token-by-token chunks.
 *
 * Events:
 *   data: {"type":"chunk","content":"..."}\n\n   — streamed text token
 *   data: {"type":"done","toolsUsed":[...]}\n\n   — final event, stream ends
 *   data: {"type":"error","message":"..."}\n\n    — error, stream ends
 */

import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { runAgent, AgentContext } from '@/lib/agent/agent';
import { createClient } from '@/lib/database/client';

function getDb() {
  return createClient();
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const send = (data: object) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Parse body first (must happen before streaming starts)
  let body: any;
  try {
    body = await request.json();
  } catch {
    writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'Invalid request body' })}\n\n`));
    writer.close();
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  const { message, conversationHistory = [], context, subscriptionId } = body;
  const sessionId = body.sessionId || `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  if (!message) {
    send({ type: 'error', message: 'Message is required' });
    writer.close();
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    send({ type: 'error', message: 'AI service not configured' });
    writer.close();
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  const recentHistory = (conversationHistory as any[]).slice(-6);

  const agentContext: AgentContext = {
    platform: context?.platform || 'ps',
    budget: context?.budget || 0,
    squadSummary: context?.squadSummary || '',
    formation: context?.formation || '',
    preferences: context?.preferences || {},
  };

  // Load saved context if subscriptionId given
  if (subscriptionId && !context) {
    try {
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
    } catch { /* ignore, proceed without saved context */ }
  }

  // Run agent in background — stream chunks as they arrive
  let fullResponse = '';
  const t0 = Date.now();

  runAgent(message, recentHistory, agentContext,
    (chunk) => {
      fullResponse += chunk;
      send({ type: 'chunk', content: chunk });
    },
    (status) => {
      send({ type: 'status', message: status });
    }
  )
    .then(async (result) => {
      const elapsed = Date.now() - t0;
      console.log(`[Agent Stream] Done in ${elapsed}ms | Tools: ${result.toolCalls.map(t => t.toolName).join(', ') || 'none'}`);

      // Extract suggested follow-up
      let suggestedNext = '';

      // If no chunks were streamed (non-streaming path, e.g. reasoning models),
      // send the full response as a single chunk before done.
      if (!fullResponse && result.response) {
        let responseToSend = result.response;
        const suggestMatch2 = responseToSend.match(/\[SUGGEST\]([\s\S]*?)\[\/SUGGEST\]/);
        if (suggestMatch2) {
          suggestedNext = suggestMatch2[1].trim();
          responseToSend = responseToSend.replace(/\s*\[SUGGEST\][\s\S]*?\[\/SUGGEST\]\s*/, '').trimEnd();
        }
        send({ type: 'chunk', content: responseToSend });
        fullResponse = responseToSend;
      }

      // Extract [SUGGEST] tag from streamed response
      const suggestMatch = fullResponse.match(/\[SUGGEST\]([\s\S]*?)\[\/SUGGEST\]/);
      if (suggestMatch) {
        suggestedNext = suggestMatch[1].trim();
        // Strip the [SUGGEST] tag from the response — send a replace event to clean client-side content
        const cleanResponse = fullResponse.replace(/\s*\[SUGGEST\][\s\S]*?\[\/SUGGEST\]\s*/, '').trimEnd();
        if (cleanResponse !== fullResponse) {
          send({ type: 'replace', content: cleanResponse });
          fullResponse = cleanResponse;
        }
      }

      send({ type: 'done', toolsUsed: result.toolCalls.map(t => t.toolName), suggestedNext });
      writer.close();

      // Persist to DB (fire-and-forget)
      try {
        const db = getDb();
        await db.from('agent_interactions').insert({ push_subscription_id: subscriptionId || null, session_id: sessionId, role: 'user', content: message });
        await db.from('agent_interactions').insert({ push_subscription_id: subscriptionId || null, session_id: sessionId, role: 'assistant', content: fullResponse || result.response, tool_calls: result.toolCalls.length > 0 ? result.toolCalls : null });
      } catch (dbErr: any) {
        console.error('[Agent Stream] DB save failed:', dbErr?.message);
      }
    })
    .catch((err: any) => {
      console.error('[Agent Stream] Error:', err?.message);
      send({ type: 'error', message: err?.message || 'Agent failed' });
      writer.close();
    });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}
