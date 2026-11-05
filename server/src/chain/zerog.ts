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
export class ZeroGStorage implements BlobStore {
  readonly kind = "0g-storage";
  private key: Uint8Array;
  constructor(private cfg: Config) {
    if (!cfg.ZG_PRIVATE_KEY) throw new Error("0G Storage needs ZG_PRIVATE_KEY");
    this.key = createHash("sha256").update(`ordo:evidence:${cfg.ZG_PRIVATE_KEY.replace(/^0x/, "")}`).digest();
  }
  async put(bytes: Uint8Array) {
    const { Indexer, MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
    const indexer = new Indexer(this.cfg.ZG_INDEXER_URL);
    const [r, err] = await indexer.upload(new MemData(bytes), this.cfg.ZG_RPC_URL, (await wallet(this.cfg)) as never, { encryption: { type: "aes256", key: this.key } } as never);
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
