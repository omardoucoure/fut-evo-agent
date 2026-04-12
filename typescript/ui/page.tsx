'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Bot } from 'lucide-react';
import Link from 'next/link';
import { useLocale } from '@/contexts/LocaleContext';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseMessageWithLinks(content: string, locale: string) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const playerName = part.slice(2, -2);
      const searchQuery = encodeURIComponent(playerName);

      return (
        <Link
          key={index}
          href={`/${locale}/players?search=${searchQuery}`}
          className="text-purple-400 hover:text-purple-300 underline decoration-purple-400/50 hover:decoration-purple-300 transition-colors font-semibold"
        >
          {playerName}
        </Link>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export default function AgentPage() {
  const { t, locale } = useLocale();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [displayedContent, setDisplayedContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasGreeted = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, displayedContent, scrollToBottom]);

  // Disable parent scroll and hide footer for chat page
  useEffect(() => {
    const scrollContainer = document.getElementById('main-scroll-container');
    const footerWrapper = scrollContainer?.querySelector('main + div') as HTMLElement | null;

    if (scrollContainer) {
      scrollContainer.style.overflow = 'hidden';
    }
    if (footerWrapper) {
      footerWrapper.style.display = 'none';
    }

    return () => {
      if (scrollContainer) {
        scrollContainer.style.overflow = '';
      }
      if (footerWrapper) {
        footerWrapper.style.display = '';
      }
    };
  }, []);

  // Auto-send greeting on first load
  useEffect(() => {
    if (hasGreeted.current) return;
    hasGreeted.current = true;

    const sendGreeting = async () => {
      setIsLoading(true);
      try {
        const response = await fetch('/api/squad-ai-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: t('agent.greeting'),
            conversationHistory: [],
          }),
        });

        if (!response.ok) throw new Error('Failed to get AI response');
        const data = await response.json();

        const aiMessage: ChatMessage = { role: 'assistant', content: data.response };
        setMessages([aiMessage]);
        startTypingEffect(data.response);
      } catch {
        setMessages([{ role: 'assistant', content: t('agent.errorMessage') }]);
      } finally {
        setIsLoading(false);
      }
    };

    sendGreeting();
  }, [t]);

  const startTypingEffect = (fullText: string) => {
    setIsTyping(true);
    setDisplayedContent('');
    let index = 0;

    const interval = setInterval(() => {
      if (index < fullText.length) {
        setDisplayedContent(fullText.slice(0, index + 2));
        index += 2;
      } else {
        clearInterval(interval);
        setIsTyping(false);
        setDisplayedContent('');
      }
    }, 8);
  };

  const handleSend = async (message: string) => {
    if (!message.trim() || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: message };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/squad-ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationHistory: updatedMessages,
        }),
      });

      if (!response.ok) throw new Error('Failed to get AI response');
      const data = await response.json();

      const aiMessage: ChatMessage = { role: 'assistant', content: data.response };
      setMessages(prev => [...prev, aiMessage]);
      startTypingEffect(data.response);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: t('agent.errorMessage') }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100dvh-var(--header-height))]">
      {/* Header */}
      <div className="px-4 pt-6 pb-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">{t('agent.title')}</h1>
              <p className="text-xs text-white/50">{t('agent.subtitle')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Chat messages — scrollable */}
      <div className="flex-1 overflow-y-auto px-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-4 pb-4">
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            const isAssistant = message.role === 'assistant';
            const showTyping = isTyping && isLast && isAssistant;

            return (
              <div
                key={index}
                className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}
              >
                {isAssistant && (
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-white/10 flex items-center justify-center mr-2 mt-1 flex-shrink-0">
                    <Bot className="w-3.5 h-3.5 text-purple-400" />
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-xl p-3 ${
                    isAssistant
                      ? 'bg-white/5 border border-white/10 text-white'
                      : 'bg-gradient-to-br from-purple-600 to-purple-700 text-white'
                  }`}
                >
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {isAssistant
                      ? showTyping
                        ? parseMessageWithLinks(displayedContent, locale)
                        : parseMessageWithLinks(message.content, locale)
                      : message.content
                    }
                    {showTyping && (
                      <span className="inline-block w-0.5 h-4 bg-purple-400 animate-pulse ml-0.5 align-text-bottom" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Loading indicator */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-white/10 flex items-center justify-center mr-2 mt-1 flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                <div className="flex items-center gap-2 text-white">
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input — pinned at bottom */}
      <div className="flex-shrink-0 px-4 pt-2 pb-4 lg:pb-4 pb-safe">
        <div className="max-w-3xl mx-auto">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('agent.placeholder')}
              disabled={isLoading}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/40 focus:outline-none focus:border-purple-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-sm backdrop-blur-sm"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-400 hover:to-pink-400 text-white p-3 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 hover:scale-105 active:scale-95"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
        {/* Spacer for mobile bottom nav */}
        <div className="lg:hidden h-14" />
      </div>
    </div>
  );
}
