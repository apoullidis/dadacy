/**
 * `@kinvara/core-modules/credential` — the `credential` module's scheme half (T-060, re-scoped by
 * CUT-T-060 R-1): the `credential_scheme` read path (Q-1) with its 60 s in-process cache, the
 * closed `mandatory_rules` parse (R-3), the display-name lookup with an explicit missing locale
 * (R-6), and the reference validator. The `sitter_credential` repository is `T-255`'s, not here.
 *
 * TWO-APPROVAL PATH (PROTOCOL §3, EV-30): everything under `src/credential/`. This file is the
 * subpath's whole public surface; import it by package name only (a relative path into `src/`
 * bypasses the `exports` map and nothing refuses it, T-245 RW1-C §1 row 2).
 *
 * The contract is state/EP-5/T-060.md § Published contract — LIVE.
 */
export {
  CHECK_TYPES,
  CredentialSchemeReadError,
  isMandatoryForEverySitter,
  MANDATORY_RULES_UNREADABLE,
  MandatoryRulesUnreadableError,
  MandatoryRulesV1,
  parseMandatoryRules,
  SCHEME_READ_REFUSED,
  VALIDITY_MODELS,
  type CheckType,
  type CredentialScheme,
  type MandatoryRules,
  type ValidityModel,
} from './scheme.ts';
export {
  CredentialSchemeCache,
  JURISDICTION_REFUSED,
  readCredentialSchemes,
  SCHEME_CACHE_TTL_MS,
  SCHEME_READ_REFUSED_LOG,
  type CredentialSchemeCacheOptions,
  type SchemeLoader,
} from './read.ts';
export {
  REFERENCE_PATTERN_UNUSABLE,
  REFERENCE_REFUSED_LOG,
  REFERENCE_REGEX_FLAGS,
  ReferenceNumberRefusedError,
  ReferencePatternUnusableError,
  validateReference,
  type ReferenceOutcome,
  type ReferenceRefusalReason,
} from './reference.ts';
export { schemeDisplayName, type SchemeDisplayName } from './display.ts';
