/**
 * 0G: evidence files on 0G Storage, and diagnosis on 0G Compute with the provider's TEE signature checked per answer.
 * Galileo testnet (chain 16602). The SDKs load only when 0G is configured.
 */
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { GuardedLlm, buildUserMessage, toModelSchema, type LlmProvider } from "../adapters/llm.js";

export const ZG_EXPLORER = "https://chainscan-galileo.0g.ai";

async function wallet(cfg: Config) {
  if (!cfg.ZG_PRIVATE_KEY) throw new Error("0G needs ZG_PRIVATE_KEY");
  const { Wallet, JsonRpcProvider } = await import("ethers");
  return new Wallet(cfg.ZG_PRIVATE_KEY.replace(/^(0x)?/, "0x"), new JsonRpcProvider(cfg.ZG_RPC_URL));
}

/**
 * The storage SDK logs every upload's options, the encryption key among them, so it would land in the server's logs.
 * That one line is dropped; the SDK's progress lines still print.
 */
let uploadLogQuiet = false;
function quietUploadOptions() {
  if (uploadLogQuiet) return;
  uploadLogQuiet = true;
  const log = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Upload options")) return;
    log(...args);
  };
}

export interface BlobStore {
  readonly kind: string;
  /** Upload; returns the Merkle root that names the file on 0G and the submission transaction. */
  put(bytes: Uint8Array): Promise<{ root: string; tx: string; url: string }>;
  get(root: string): Promise<Uint8Array>;
}

/**
 * Evidence on 0G Storage, encrypted (AES-256) with a key derived from Ordo's 0G key, so files are available and
 * tamper-evident on 0G without being readable by anyone else. The root is of the ciphertext; Ordo checks a download by
 * decrypting it and comparing the SHA-256 recorded in its ledger.
 */
const UPLOAD_LIMIT_MS = 180_000;

export class ZeroGStorage implements BlobStore {
  readonly kind = "0g-storage";
  private key: Uint8Array;
  constructor(private cfg: Config) {
    if (!cfg.ZG_PRIVATE_KEY) throw new Error("0G Storage needs ZG_PRIVATE_KEY");
    this.key = createHash("sha256").update(`ordo:evidence:${cfg.ZG_PRIVATE_KEY.replace(/^0x/, "")}`).digest();
  }
  /**
   * Uploads one at a time: they all sign with the one 0G wallet, and two at once take the same nonce and one fails.
   * Each gets UPLOAD_LIMIT_MS, so an upload that never returns fails instead of holding every one after it (and the
   * engine cycle that waits on them).
   */
  private queue: Promise<unknown> = Promise.resolve();
  put(bytes: Uint8Array) {
    const next = this.queue.then(() => {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`0G upload: no answer in ${UPLOAD_LIMIT_MS / 1000} s`)), UPLOAD_LIMIT_MS);
      });
      return Promise.race([this.upload(bytes), limit]).finally(() => clearTimeout(timer));
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async upload(bytes: Uint8Array) {
    const { Indexer, MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
    quietUploadOptions();
    const indexer = new Indexer(this.cfg.ZG_INDEXER_URL);
    // not waiting for finality: Ordo records the root and the submission once the segments are on the storage nodes, and
    // a node that never reports the entry finalized (seen on the testnet) would otherwise hold the upload forever
    const [r, err] = await indexer.upload(new MemData(bytes), this.cfg.ZG_RPC_URL, (await wallet(this.cfg)) as never, { encryption: { type: "aes256", key: this.key }, finalityRequired: false } as never);
    if (err) throw new Error(`0G upload: ${err.message ?? err}`);
    const one = "rootHash" in r ? r : { rootHash: r.rootHashes[0]!, txHash: r.txHashes[0]! };
    return { root: one.rootHash, tx: one.txHash, url: `${ZG_EXPLORER}/tx/${one.txHash}` };
  }
  async get(root: string) {
    const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
    const [blob, err] = await new Indexer(this.cfg.ZG_INDEXER_URL).downloadToBlob(root, { proof: true, decryption: { symmetricKey: this.key } });
    if (err) throw new Error(`0G download: ${err.message ?? err}`);
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/**
 * Diagnosis and recommendations on 0G Compute: an OpenAI-compatible call to a provider running the model in a TEE,
 * billed through Ordo's 0G ledger. Each answer's chat id is checked against the provider's signature
 * (processResponse); the result says whether it verified.
 */
export async function zeroGComputeProvider(cfg: Config): Promise<LlmProvider> {
  const { createZGComputeNetworkBroker } = await import("@0gfoundation/0g-compute-ts-sdk");
  const broker = await createZGComputeNetworkBroker((await wallet(cfg)) as never);
  let provider = cfg.ZG_PROVIDER_ADDRESS;
  if (!provider) {
    const services = (await broker.inference.listService()) as unknown as { provider: string; serviceType?: string; verifiability?: string }[];
    provider = (services.find((s) => (s.serviceType ?? "chatbot") === "chatbot" && s.verifiability) ?? services.find((s) => (s.serviceType ?? "chatbot") === "chatbot"))?.provider;
  }
  if (!provider) throw new Error("No 0G inference provider available");
  await broker.inference.acknowledgeProviderSigner(provider).catch(() => undefined);
  const { endpoint, model } = await broker.inference.getServiceMetadata(provider);
  const p = provider;
  return new GuardedLlm(
    {
      name: "0g-compute",
      modelId: model,
      call: async (task, signal) => {
        const body = JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: `${task.system}\nRespond with JSON only, matching this JSON Schema:\n${JSON.stringify(toModelSchema(task.schema))}` },
            { role: "user", content: buildUserMessage(task) },
          ],
        });
        const headers = (await broker.inference.getRequestHeaders(p, body)) as unknown as Record<string, string>;
        const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal });
        if (!res.ok) throw new Error(`0G Compute HTTP ${res.status}`);
        const json = (await res.json()) as { id?: string; usage?: unknown; choices?: { message?: { content?: string } }[] };
        const text = json.choices?.[0]?.message?.content;
        if (!text) throw new Error("empty model response");
        const chatId = res.headers.get("ZG-Res-Key") ?? json.id ?? null;
        const verified = chatId ? await broker.inference.processResponse(p, chatId, json.usage ? JSON.stringify(json.usage) : undefined).catch(() => false) : null;
        return { text, attestation: { kind: "0g-compute", provider: p, chatId, verified } };
      },
    },
    cfg.LLM_TIMEOUT_MS,
  );
}
