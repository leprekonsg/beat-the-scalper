/**
 * extractAnnouncement: runtime extraction of a draft release record from a supplied
 * announcement (BTS_FABLE_BUILD_PLAN.md section 8; prompts/extract-announcement.md).
 * The model's structured output is a proposal, never a verified fact -- code applies
 * the rules in `applyCodeRules` before returning, regardless of what was requested.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageBlockParam, MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { AnnouncementExtractionSchema, AnnouncementExtractionWireSchema, announcementFromWire, type AnnouncementExtraction, type AnnouncementExtractionWire } from '../domain/types.ts';
import type { FableClient, TaskResult } from './client.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(moduleDir, '../../prompts/extract-announcement.md');

export interface ExtractAnnouncementInput {
  evidenceId: string;
  text?: string;
  imagePng?: Buffer;
  sourceUrl?: string | null;
  userExpectedTimeLocal?: string | null;
}

export async function extractAnnouncement(client: FableClient, input: ExtractAnnouncementInput): Promise<TaskResult<AnnouncementExtraction>> {
  const system = readFileSync(PROMPT_PATH, 'utf8');

  const contentBlocks: (TextBlockParam | ImageBlockParam)[] = [];
  if (input.imagePng) {
    contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.imagePng.toString('base64') } });
  }

  const lines: string[] = [`Evidence ID: ${input.evidenceId}`];
  if (input.text) lines.push(`Pasted/fetched source text:\n${input.text}`);
  if (input.sourceUrl) lines.push(`Source URL: ${input.sourceUrl}`);
  if (input.userExpectedTimeLocal) {
    lines.push(`Collector-reported expected local time (a user expectation, not a source confirmation): ${input.userExpectedTimeLocal}`);
  }
  if (!input.text && !input.imagePng) lines.push('No pasted text or image was supplied for this evidence; only the fields above are available.');
  // This function's input carries no trustworthy capture-time anchor for any of its
  // callers, so this statement is always explicit and unconditional (never inferred
  // from upload time or a phone status-bar clock).
  lines.push('Capture date/time unknown.');
  contentBlocks.push({ type: 'text', text: lines.join('\n\n') });

  const messages: MessageParam[] = [{ role: 'user', content: contentBlocks }];
  const taskName = input.imagePng ? 'extract-announcement-screenshot' : 'extract-announcement';

  const result = await client.runTask<AnnouncementExtraction>({
    name: taskName,
    system,
    messages,
    outputSchema: AnnouncementExtractionSchema,
    wire: { schema: AnnouncementExtractionWireSchema, toDomain: (w) => announcementFromWire(w as AnnouncementExtractionWire, input.evidenceId) },
  });

  if (!result.ok) return result;
  return { ...result, output: applyCodeRules(result.output) };
}

/**
 * Code rules that must hold regardless of the model's proposal (BTS_FABLE_BUILD_PLAN
 * section 8, A06):
 *  - A `dateBasis: source_confirmed` claim with no resolved release date is downgraded
 *    to `unknown`; the model cannot assert a confirmed date without a date value.
 *  - `relativeAge` is passed through unchanged: the verbatim text (e.g. "42 minutes
 *    ago") must never be overwritten or resolved into an absolute instant here.
 */
function applyCodeRules(x: AnnouncementExtraction): AnnouncementExtraction {
  if (x.dateBasis === 'source_confirmed' && x.releaseDateLocal.value === null) {
    return { ...x, dateBasis: 'unknown' };
  }
  return x;
}
