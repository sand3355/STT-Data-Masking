function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  logLevel: optional('LOG_LEVEL', 'info'),
  maxFileSizeMb: parseInt(optional('MAX_FILE_SIZE_MB', '10'), 10),

  // Output-token budget for masking calls, where the model re-emits the whole
  // document. Probed 2026-07-28: the claude-4.8-opus deployment accepts up to
  // 128k; 64k leaves headroom while covering ~150 KB of text content.
  maskMaxTokens: parseInt(optional('MASK_MAX_TOKENS', '64000'), 10),

  // Size-based ROUTING thresholds — not caps. The 10 MB upload limit
  // (maxFileSizeMb) is the only user-facing limit; these just pick the right
  // processing strategy for the size at hand.
  limits: {
    // AI Core Converse rejects document blocks over ~4.5 MB once base64-encoded
    // (+33%), so raw files above ~3 MB cannot be sent natively. Larger
    // spreadsheets/PDFs fall back to their extracted-text path automatically.
    maxAiFileBytes: 3 * 1024 * 1024,
    // Documents up to maxSinglePassChars are masked in one AI call. Larger
    // spreadsheets switch to plan-based masking (sampled headers/rows, applied
    // mechanically); larger Word/PDF text is analysed for sensitive values in
    // one or more detection passes and masked mechanically.
    maxSinglePassChars: 150_000,
  },

  aiCore: {
    inferenceUrl: optional('SAP_AI_CORE_INFERENCE_URL', ''),
    oauthUrl: optional('SAP_AI_CORE_OAUTH_URL', ''),
    clientId: optional('SAP_AI_CORE_CLIENT_ID', ''),
    clientSecret: optional('SAP_AI_CORE_CLIENT_SECRET', ''),
    deploymentId: optional('SAP_AI_CORE_DEPLOYMENT_ID', ''),
    resourceGroup: optional('SAP_AI_CORE_RESOURCE_GROUP', 'default'),
  },

  validate(): void {
    const missing: string[] = [];
    if (!this.aiCore.inferenceUrl) missing.push('SAP_AI_CORE_INFERENCE_URL');
    if (!this.aiCore.oauthUrl) missing.push('SAP_AI_CORE_OAUTH_URL');
    if (!this.aiCore.clientId) missing.push('SAP_AI_CORE_CLIENT_ID');
    if (!this.aiCore.clientSecret) missing.push('SAP_AI_CORE_CLIENT_SECRET');
    if (!this.aiCore.deploymentId) missing.push('SAP_AI_CORE_DEPLOYMENT_ID');
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  },
};
