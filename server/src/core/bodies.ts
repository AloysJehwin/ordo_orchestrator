import type { Hex } from "viem";
import type { AssetKind } from "../domain/types.js";

/**
 * A machine's body: the program that runs a virtual machine for one asset. It simulates the machine's process, streams
 * its telemetry, captures and signs the media for its stages' outcomes, reads them with its on-board agent through 0G,
 * buys what its next stages consume, and stops safely when 0G is unreachable. It talks to Ordo only over the signed
 * edge channel (`/v1/edge/*`, every request signed with its device key), like a gateway next to a real machine.
 *
 * A runner starts and stops bodies: `local` spawns a process on the Ordo host (dev and tests), `sandbox` a Vercel
 * Sandbox microVM per machine.
 */
export type BodyRuntime = "local" | "sandbox";
export type BodyState = "stopped" | "starting" | "running" | "sleeping" | "safe_stopped" | "failed";

/** What a body is started with: the environment of its process or VM. */
export interface BodyEnv {
  /** Ordo's public base URL, as the body reaches it */
  ORDO_URL: string;
  /** the machine's device key: its address is the asset's gateway (data source) */
  BODY_KEY: Hex;
  BODY_ASSET: string;
  /** the kind of machine, which picks its process model and media */
  BODY_PROFILE: AssetKind;
  /** seed for the process model, so a run can be replayed */
  BODY_SEED: string;
  /** the port the body answers questions on (`GET /ask?q=`) */
  BODY_ASK_PORT?: string;
  /** the 0G Router, private mode: a per-start key Ordo mints and revokes on stop. Unset: the body runs without a brain, labelled so */
  ZG_ROUTER_URL?: string;
  ZG_ROUTER_KEY?: string;
  ZG_ROUTER_MODEL?: string;
  ZG_ROUTER_AUDIO_MODEL?: string;
  /** the machine's own Hedera account, which pays vendors over x402 */
  HEDERA_NETWORK?: string;
  MACHINE_ACCOUNT_ID?: string;
  MACHINE_ACCOUNT_KEY?: string;
}

export interface BodyLaunch {
  siteId: string;
  assetId: string;
  profile: AssetKind;
  env: BodyEnv;
}

export interface BodyStatus {
  assetId: string;
  runtime: BodyRuntime;
  state: BodyState;
  /** the last time the body reported (its newest observation) */
  heartbeatAt: string | null;
  /** "0g" when its agent reads and decides through the 0G Router; "none" when it runs without one */
  brain: "0g" | "none";
  /** the microVM, for the sandbox runtime */
  sandboxId: string | null;
  error: string | null;
  /** the newest episode log copy on 0G Storage */
  episodeRoot: string | null;
}

/** Starts and stops bodies on one kind of runtime. */
export interface BodyRunner {
  readonly runtime: BodyRuntime;
  /** start (or wake) the body; returns where it answers questions */
  start(launch: BodyLaunch): Promise<{ sandboxId: string | null; askUrl: string | null }>;
  /** stop it (a sandbox snapshots so the next start is fast) */
  stop(assetId: string): Promise<void>;
  /** whether it is alive right now */
  alive(assetId: string): Promise<{ alive: boolean; detail?: string }>;
}

/** What Ordo asks a body: questions about its run, answered from its episode log through 0G. */
export interface BodyAnswer {
  answer: string;
  /** the 0G request behind the answer; null when the body has no brain */
  requestId: string | null;
  model: string | null;
}
