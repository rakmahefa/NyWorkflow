/**
 * @nyworkflow/webapi — la passerelle du monorepo.
 *
 * Refonte moderne et maintenue de ny-gemini-acp (Rust, non maintenu) :
 * l'interface web Gemini servie en OpenAI-compatible, directement dans
 * NyWorkflow. Pour l'instant le provider est Gemini — l'abstraction Provider
 * est prête pour les suivants.
 *
 * Zéro dépendance runtime : node:http, node:crypto, fetch natif.
 * Les ré-exports portent des extensions .ts explicites — le package est
 * chargé par Node en type stripping (leçon M3), où les imports ESM nus
 * ne résolvent pas.
 */

// Serveur + provider
export { createWebApiServer, webApiProviderFromConfig } from './server.ts'
export { createGeminiProvider } from './provider.ts'
export type { Provider, ProviderChatOptions } from './provider.ts'

// Client Gemini
export { GeminiWebClient, GeminiError, DEFAULT_BL, backoffMs } from './gemini.ts'
export type { GeminiErrorKind, GeminiClientConfig, GeminiTurnOptions, GeminiStreamItem } from './gemini.ts'

// Configuration
export { loadWebApiConfig, defaultCookieFile, findRepoRoot, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_GEMINI_BASE_URL } from './config.ts'
export type { WebApiConfig } from './config.ts'

// Multi-comptes & journal (M8) — manifeste /u/N, expiration et stats par compte (M9)
export { CookieStore, loadAccountsManifest } from './accounts.ts'
export type { AccountStatus, ManifestSource } from './accounts.ts'
export { TurnJournal, DEFAULT_JOURNAL_CAPACITY, accountUsage } from './journal.ts'
export type { TurnRecord, AccountUsage } from './journal.ts'
export type { GeminiDescribe } from './gemini.ts'

// Proxy sortant (M8)
export { parseProxyEnv, shouldBypass, maskCredentials, upstreamFetch, loadTlsCa } from './proxy.ts'
export type { ProxyEnv, UpstreamResponse, UpstreamInit, UpstreamOptions } from './proxy.ts'

// Modèles (data-driven)
export { loadModelTable, resolveModel, resolveModelStrict, listModelIds, DEFAULT_MODEL, DEFAULT_MODEL_TABLE, UnknownModelError } from './models.ts'
export type { ModelSpec, ModelTable, ResolvedModel } from './models.ts'

// Outils client & API élargie (M10) — tools OpenAI, routes Google-style v1beta
export { normalizeTools, parseToolChoice, toolsPreamble, ToolStreamSplitter, ToolValidationError, scanJsonValue, solveToolBlock, openAiArguments, TOOLS_OPEN, TOOLS_CLOSE, MAX_TOOL_BLOCK_BYTES } from './tools.ts'
export type { ToolSpec, ToolChoice, ParsedToolCall, ToolStreamEvent } from './tools.ts'
export { v1betaModelInfo, parseGenerateRequest, buildGenerateResponse, generateTextChunk, generateCallChunk, generateFinalChunk, usageMetadata, callToText } from './v1beta.ts'
export type { V1BetaModelInfo, NormalizedGenerateRequest } from './v1beta.ts'

// Briques réutilisables
export { CookieJar, loadCookieSource } from './cookies.ts'
export type { CookieEntry, CookieSource } from './cookies.ts'
export { sapisidHash, sapisidHashAt, GEMINI_ORIGIN } from './auth.ts'
export { buildFreq, extractPageTokens, extractBl, extractField, urlencode, nextReqid } from './payload.ts'
export type { PageTokens, PayloadModel } from './payload.ts'
export { FrameDecoder, cleanText, bardErrorCode, isEmptyStream } from './frames.ts'
export type { FrameEvent } from './frames.ts'
export { messagesToPrompt, contentText, usage, tokenEstimate } from './convert.ts'
export type { ChatMessage } from './convert.ts'
export { WEBAPI_VERSION } from './version.ts'
