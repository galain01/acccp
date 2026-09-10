# Model cost tracking

For new conversions, prefer the gateway's valid `x-litellm-response-cost` response header, including a reported zero. LiteLLM documents this as the call's USD cost. The app retains only that amount, never unrelated response headers or provider error bodies. If it is absent or invalid, estimate from `/model/info` rates and reported tokens. Missing pricing does not discard token usage. [LiteLLM response headers](https://docs.litellm.ai/docs/proxy/response_headers)

When the gateway cannot supply rates for `gpt-5.6-sol-2026-07-09`, `gpt-5.6-sol`, or `gpt-5.6`, the app uses a labeled OpenAI standard list-price estimate. The dated gateway ID is treated as the Sol family for this estimate; the gateway's actual routing and bill are not independently verified by that name. Other model IDs receive no automatic fallback.

Rates verified September 10, 2026, in USD per million tokens:

| Prompt size          | Ordinary input | Cached input | Cache writes | Output |
| -------------------- | -------------: | -----------: | -----------: | -----: |
| Up to 272,000 tokens |          $4.00 |        $0.40 |        $5.00 | $20.00 |
| Above 272,000 tokens |          $8.00 |        $0.80 |       $10.00 | $30.00 |

The long-context tier applies to the entire request. OpenAI guarantees the promotional Sol rates at least through November 21, 2026; the built-in fallback stops on November 22 UTC until reverified and updated. Gateway-provided pricing continues to work. [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Sol model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

List-price estimates are not invoices. They may differ from gateway discounts, markups, service tiers or other adjustments. Reported cache-read and cache-write tokens receive their respective rates without double counting. Missing cache details use ordinary input rates; this is particularly relevant to historical calls, whose cache breakdown was not saved. Gateway metadata without cache rates likewise uses its ordinary input rate for that portion.

Historical stored costs remain immutable. Any current-price estimate displayed for previously unpriced calls must be labeled separately; it must not be presented as a recovered billed amount or written over stored history. A missing amount is unknown, not free.

Metadata requests can also fail when a key's budget is exhausted. The fallback addresses unavailable pricing, not gateway authorization or budget exhaustion; it cannot make a rejected conversion succeed.
