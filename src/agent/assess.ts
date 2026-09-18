/**
 * FableOfferInterpreter: assesses the current retailer offer against an approved
 * PurchaseIntent using prompts/assess-offer.md (BTS_FABLE_BUILD_PLAN.md section 8).
 * Implements the worker's OfferInterpreter contract by structural shape
 * (`OfferInterpreterLike`, defined locally to avoid a hard import into a module the
 * worker agent is writing concurrently).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageBlockParam, MessageParam, TextBlockParam, ToolUnion } from '@anthropic-ai/sdk/resources/messages/messages';
import { OfferAssessmentSchema, type Evidence, type Observation, type OfferAssessment, type Provenance, type PurchaseIntent } from '../domain/types.ts';
import type { RestrictedBrowserExecutor } from './browserExecutor.ts';
import type { FableClient } from './client.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(moduleDir, '../../prompts/assess-offer.md');

export type OfferAssessmentOutcome =
  | { ok: true; assessment: OfferAssessment; provenance: Provenance }
  | { ok: false; reason: string; provenance: Provenance };

/**
 * Local copy of the worker's `OfferInterpreter` contract (src/worker/worker.ts).
 * Kept in sync by shape, not by import: the worker module is owned elsewhere.
 */
export interface OfferInterpreterLike {
  assess(input: { intent: PurchaseIntent; observation: Observation; evidence: Evidence | null }): Promise<OfferAssessmentOutcome>;
}

export interface FableOfferInterpreterOptions {
  dataDir: string;
  /** Present only when a live/replay browser session is available; pass an observe-mode executor. */
  browserExecutor?: RestrictedBrowserExecutor;
}

export class FableOfferInterpreter implements OfferInterpreterLike {
  private readonly client: FableClient;
  private readonly dataDir: string;
  private readonly browserExecutor?: RestrictedBrowserExecutor;
  private readonly system: string;

  constructor(client: FableClient, opts: FableOfferInterpreterOptions) {
    this.client = client;
    this.dataDir = opts.dataDir;
    this.browserExecutor = opts.browserExecutor;
    this.system = readFileSync(PROMPT_PATH, 'utf8');
  }

  async assess(input: { intent: PurchaseIntent; observation: Observation; evidence: Evidence | null }): Promise<OfferAssessmentOutcome> {
    // Never send accountRef or any credential to the model.
    const { accountRef: _accountRef, ...intentWithoutAccount } = input.intent;

    const contentBlocks: (ImageBlockParam | TextBlockParam)[] = [];
    const evidenceId = input.evidence?.evidenceId ?? null;
    if (evidenceId) {
      const imagePath = resolve(this.dataDir, 'evidence', `${evidenceId}.png`);
      if (existsSync(imagePath)) {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: readFileSync(imagePath).toString('base64') },
        });
      }
    }
    contentBlocks.push({
      type: 'text',
      text: [
        `Approved PurchaseIntent (accountRef and any credentials withheld):\n${JSON.stringify(intentWithoutAccount, null, 2)}`,
        `Latest observation:\n${JSON.stringify(input.observation, null, 2)}`,
      ].join('\n\n'),
    });

    const messages: MessageParam[] = [{ role: 'user', content: contentBlocks }];
    // The browser toolset is included only when the caller supplies an executor,
    // which for offer assessment must be in an observe-only mode ('lazada_observe');
    // this module does not itself choose or override that mode.
    const tools: ToolUnion[] | undefined = this.browserExecutor ? [this.browserExecutor.toolsetDefinition()] : undefined;

    const result = await this.client.runTask<OfferAssessment>({
      name: 'assess-offer',
      system: this.system,
      messages,
      tools,
      outputSchema: OfferAssessmentSchema,
      browserExecutor: this.browserExecutor,
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason, provenance: result.provenance };
    }
    return { ok: true, assessment: result.output, provenance: result.provenance };
  }
}
