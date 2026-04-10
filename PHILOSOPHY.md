# PHILOSOPHY

## The Missing Lane

When AI agents begin to pay autonomously, they will reach for the rails that exist. Today, those rails are denominated in dollars. Coinbase built x402 around USDC — and that was the right thing to do. Someone had to go first, and they did.

But there is no lane for the yen.

JPYC supports EIP-3009 — `transferWithAuthorization` exists on the implementation contract behind the proxy. But Coinbase's CDP facilitator does not support JPYC. It only settles USDC on Base. Without a custom facilitator, there is no way to use JPYC for x402 payments. The door is closed.

So we open it.

This project does not reinvent x402. It inherits the protocol — the 402 status code, the payment headers, the facilitator pattern — and adds a single new lane: JPYC on Polygon, settled via EIP-3009 `transferWithAuthorization`. One scheme. One token. One network. Nothing more than what is necessary.

JPYC is not a speculative asset. It is classified as a prepaid payment instrument under current Japanese law, with a stated path toward becoming a regulated electronic payment instrument (stablecoin) under the amended Payment Services Act. In either form, it represents yen on-chain. When an AI agent pays with JPYC, it pays in Japanese yen.

The first person to build a working thing writes the standard. Not the first person to write a proposal. Not the first person to file an issue. The one who ships.

This is the only path by which a Japanese AI agent can autonomously pay in Japanese yen over HTTP. We are building that path.

---

## 不在のレーン

AIエージェントが自律的に支払いを行うとき、そこにあるレールを使う。今日、そのレールはドル建てだ。CoinbaseはUSDCを中心にx402を作った。それは正しい判断だった。誰かが最初に動く必要があり、彼らが動いた。

しかし、円のレーンは存在しない。

JPYCはEIP-3009に対応している — プロキシの背後にある実装コントラクトに`transferWithAuthorization`が存在する。しかし、CoinbaseのCDP facilitatorはJPYCをサポートしていない。Base上のUSDCしか決済できない。独自facilitatorなしにJPYCでx402決済はできない。扉は閉じている。

だから、開ける。

このプロジェクトはx402を再発明しない。プロトコルを継承する — 402ステータスコード、決済ヘッダー、facilitatorパターン — そこにひとつのレーンを加える。Polygon上のJPYC、EIP-3009の`transferWithAuthorization`による決済。ひとつのスキーム。ひとつのトークン。ひとつのネットワーク。必要なもの以外は何もない。

JPYCは暗号資産ではない。現行法上は前払式支払手段であり、改正資金決済法に基づく電子決済手段（ステーブルコイン）への移行が公表されている。いずれの形態であれ、オンチェーン上の円を表す。AIエージェントがJPYCで支払うとき、それは日本円で支払っている。

動くものを最初に作った人間が標準を書く。提案書を最初に書いた人間ではない。Issueを最初に立てた人間でもない。出荷した人間だ。

日本のAIエージェントがHTTPを通じて日本円で自律的に支払える経路。これがその唯一の経路だ。私たちはそれを作っている。
