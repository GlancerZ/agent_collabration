// A per-invocation overlay keeps the native CLI login while isolating provider redirects.
// It neither copies credentials nor changes the user's permissions, hooks or global files.
export const CLAUDE_LOGIN_ENV = Object.freeze({
  ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_MODEL: '', ANTHROPIC_DEFAULT_MODEL: '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: '', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: '', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: '',
  CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: ''
});
export function usesClaudeLogin(config) { return (config.agents.claude.authPolicy || 'claude-login') === 'claude-login'; }
export function claudeAuthArgs(config) {
  return usesClaudeLogin(config) ? ['--settings', JSON.stringify({ env: CLAUDE_LOGIN_ENV, apiKeyHelper: '', forceLoginMethod: 'claudeai' })] : [];
}
export function claudeAuthEnv(config, env) {
  if (!usesClaudeLogin(config)) return env;
  const copy = { ...env }; for (const key of Object.keys(CLAUDE_LOGIN_ENV)) delete copy[key]; return copy;
}
