import { AsyncLocalStorage } from 'node:async_hooks';

export type PromptInjectionProtectionMode = 'automatic' | 'enabled' | 'disabled';
const protectionContext = new AsyncLocalStorage<boolean>();

export const resolvePromptInjectionProtection = (mode: PromptInjectionProtectionMode, disabledGlobally: boolean) =>
  mode === 'enabled' || (mode === 'automatic' && !disabledGlobally);

export const withPromptInjectionProtection = <T>(enabled: boolean, work: () => T): T =>
  protectionContext.run(enabled, work);

export const isPromptInjectionProtectionEnabled = () => protectionContext.getStore() !== false;

// Only transform the outgoing copy. Stored tool history remains unchanged.
export const stripUntrustedContentWrappers = (text: string) =>
  text.replace(/<\s*\/?\s*untrusted_web_content\s*>/gi, '');

export const prepareProtectionMessages = (messages: unknown): unknown => {
  if (isPromptInjectionProtectionEnabled() || !Array.isArray(messages)) return messages;
  return messages.map(message => ({ ...message,
    content: typeof message.content === 'string' ? stripUntrustedContentWrappers(message.content)
      : Array.isArray(message.content) ? message.content.map((part: any) =>
        part.type === 'text' && typeof part.text === 'string'
          ? { ...part, text: stripUntrustedContentWrappers(part.text) } : part)
      : message.content,
  }));
};
