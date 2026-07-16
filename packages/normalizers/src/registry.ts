import { ChatCompletionsNormalizer } from "./chat-completions.js";
import {
  NormalizationExchangeSchema,
  type ExchangeNormalizer,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
} from "./contracts.js";
import { appendDiagnosticEvidence } from "./diagnostics.js";
import { ResponsesNormalizer } from "./responses.js";
import { UnknownExchangeNormalizer } from "./unknown.js";

export class NormalizerRegistry {
  constructor(
    private readonly normalizers: readonly ExchangeNormalizer[],
    private readonly fallback: ExchangeNormalizer,
  ) {}

  normalize(
    input: NormalizationExchange,
    options: NormalizationOptions = {},
  ): NormalizationResult {
    const exchange = NormalizationExchangeSchema.parse(input);
    const normalizer =
      this.normalizers.find((candidate) => candidate.supports(exchange)) ??
      this.fallback;
    return appendDiagnosticEvidence(
      exchange,
      normalizer.normalize(exchange, options),
      options,
    );
  }
}

export class DefaultNormalizerRegistry extends NormalizerRegistry {
  constructor() {
    const unknown = new UnknownExchangeNormalizer();
    super(
      [new ResponsesNormalizer(), new ChatCompletionsNormalizer(), unknown],
      unknown,
    );
  }
}
