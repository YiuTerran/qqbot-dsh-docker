# OneBot integration evidence

These are historical results from the 2026-10-02 experiment, reviewed on 2026-10-03. Every identity and private body in these fixtures is synthetic. No real QQ credentials, runtime databases, caches or configuration are committed.

`native-container-acceptance.json` records the subsequent 2026-10-03 integration: 11 checks passed using real local Gensokyo/SeaDice/qq-bot containers, including native commands, two users across two groups, concurrent isolation, deduplication, private outbox separation, restart persistence and the production qq-bot authorization wrapper. Its source pins identify the fork implementations. Both qq-bot architectures separately passed the full offline regression, including 12 SDK-backed OneBot checks. This establishes container behavior with synthetic identities, not actual QQ delivery or LLM command selection.

- `original-protocol-baseline.json`: unmodified Gensokyo `a0aa7954e557190704e84e8eb3a03c8bf543f664` fails standard group reply collection, sends no error ACK for an unsupported action, broadcasts requests and exposes private fixture text.
- `preview-synchronous-summary.json`: the first experimental repair passed nine synchronous protocol checks; this does not establish asynchronous safety.
- `preview-async-failure.json`: a real NoneBot `.splitlate` delayed continuation entered the following `.late` request. This failed result motivates the strict reply + explicit completion contract.
- `baseline-report.md`: experiment scope, source pins, native SeaDice state tests and limitations. Its statements about not adding submodules or publishing describe that completed experiment, rather than the subsequent integration.

Old `/tmp` paths identify the original local experiment artifacts; they are not required at runtime. Current integration CI uploads its own fresh container evidence as an Actions artifact. Passing synthetic tests does not prove real QQ private delivery. This official QQ deployment rejects group hidden rolls before execution; reopening requires both a revised platform contract and actual delivery evidence, as described in the integration guide.
