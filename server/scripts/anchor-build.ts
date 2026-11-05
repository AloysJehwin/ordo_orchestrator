/**
 * Proof of work: posts the current git commit to the Hedera "build" topic. Consensus timestamps
 * cannot be back-dated, so the series of anchors proves when each commit existed.
 *   HEDERA_BUILD_TOPIC_ID=0.0.x node --env-file=.env --import tsx scripts/anchor-build.ts
 */
import { execSync } from "node:child_process";
import { Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

const id = process.env.HEDERA_OPERATOR_ID;
const key = process.env.HEDERA_OPERATOR_KEY;
const topicId = process.env.HEDERA_BUILD_TOPIC_ID;
if (!id || !key || !topicId) throw new Error("Set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and HEDERA_BUILD_TOPIC_ID");
const commit = execSync("git rev-parse HEAD").toString().trim();
const tree = execSync("git rev-parse HEAD^{tree}").toString().trim();
const subject = execSync("git log -1 --format=%s").toString().trim().slice(0, 120);
const client = Client.forTestnet().setOperator(id, PrivateKey.fromStringECDSA(key.replace(/^0x/, "")));
const tx = await new TopicMessageSubmitTransaction({ topicId, message: JSON.stringify({ v: 1, repo: "ordo", commit, tree, subject, at: new Date().toISOString() }) }).execute(client);
const r = await tx.getReceipt(client);
console.log(`anchored ${commit.slice(0, 10)} as ${topicId}#${r.topicSequenceNumber} → https://hashscan.io/testnet/topic/${topicId}`);
client.close();
