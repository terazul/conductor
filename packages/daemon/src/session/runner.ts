/**
 * The Claude engine's old address (Amendment 72). It lives in backends/claude.ts now, as
 * ClaudeBackend; this keeps every existing import working, `sdk` swap point included.
 */

export * from './backends/claude.js';
export { ClaudeBackend as AgentRunner } from './backends/claude.js';
