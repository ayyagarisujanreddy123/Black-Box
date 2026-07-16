import {
  NormalizationExchangeSchema,
  NormalizationResultSchema,
  type ExchangeNormalizer,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
} from "./contracts.js";
import { materializeCanonicalEvents } from "./events.js";

export const UNKNOWN_NORMALIZER_VERSION = "1.0.0";

export class UnknownExchangeNormalizer implements ExchangeNormalizer {
  readonly id = "openai-compatible.unknown";
  readonly version = UNKNOWN_NORMALIZER_VERSION;

  supports(exchange: NormalizationExchange): boolean {
    return exchange.protocol === "unknown-openai-compatible";
  }

  normalize(
    input: NormalizationExchange,
    options: NormalizationOptions = {},
  ): NormalizationResult {
    const exchange = NormalizationExchangeSchema.parse(input);
    if (!this.supports(exchange)) {
      return NormalizationResultSchema.parse({
        parserId: this.id,
        parserVersion: this.version,
        status: "unsupported",
        events: [],
        diagnostics: [],
      });
    }

    return NormalizationResultSchema.parse({
      parserId: this.id,
      parserVersion: this.version,
      status: "parsed",
      events: materializeCanonicalEvents(
        exchange,
        [
          {
            type: "unknown_api_exchange",
            evidence: "unknown",
            summary: {
              path: exchange.path,
              rawPayloadPreserved: true,
            },
          },
        ],
        options,
      ),
      diagnostics: [],
    });
  }
}
