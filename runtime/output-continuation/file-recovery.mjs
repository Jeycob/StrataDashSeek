import { createHash } from 'node:crypto';
import path from 'node:path';

const fileTools = new Set(['write', 'edit']);
const admitted = new WeakMap();
const seedLimit = 768;
const editLimit = 1800;

export function isCreateOnlyRecoveryWrite(execution) {
  return admitted.get(execution.token)?.create === true;
}

// The pinned SDK drops every tool call at a length boundary. Inspect only
// the recorded tool name. Never parse, retain, or execute its partial JSON.
export function cutFileTool(stream) {
  return stream?.some(record => {
    if (record.type === 'tool-call-chunks') return fileTools.has(record.name);
    const chunk = record.type === 'chunk' ? record.chunk : undefined;
    return chunk?.type === 'tool-call-delta' ? fileTools.has(chunk.name) :
      chunk?.type === 'block-end' && chunk.block.type === 'tool-call' && fileTools.has(chunk.block.name);
  }) ?? false;
}

export function createFileRecovery() {
  return { confirmed: false, repeatedCut: false, committed: new Set(), pending: new Set() };
}

const writeLimit = file => file.repeatedCut && !file.confirmed ? 384 : seedLimit;

export function fileRecoverySection(file) {
  const limit = writeLimit(file);
  return {
    name: 'homeai-file-recovery', order: 10001, interpolate: false,
    text: '[File write recovery] The cut tool call wrote no file. Discard that draft. Do not compose the complete document in reasoning, text, shell or a tool argument. ' +
      (file.confirmed
        ? 'Work from the confirmed on-disk file. Add one small complete change per edit and wait for its result before the next change. '
        : 'Start with the requested file path. If missing, call write now, putting file_path first and a tiny valid starting file second. For HTML use a complete minimal document with short stable edit anchors. If it already exists, read only the relevant lines and make a targeted edit. ') +
      (file.repeatedCut && !file.confirmed ? 'A full draft failed again. Start with a few complete lines and one anchor only. ' : '') +
      'Write only creates a missing file and accepts up to ' + limit +
      ' characters. Edit one exact anchor at a time using up to 1800 characters of old and new text combined. After each confirmed change continue from the file, then verify the requested behavior. Report only files and checks actually confirmed.',
  };
}

function capped(field, limit) {
  return { ...field, maxLength: Math.min(field?.maxLength ?? limit, limit) };
}

export function fileRecoveryTools(tools, file) {
  const limit = writeLimit(file);
  return tools.map(tool => {
    if (!fileTools.has(tool.name) || !tool.parameters.properties?.file_path) return tool;
    const { file_path, ...fields } = tool.parameters.properties;
    if (tool.name === 'write') {
      fields.content = { ...capped(fields.content, limit),
        description: 'A tiny complete UTF-8 starting file. Use edit for additional sections.' };
    } else {
      fields.old_string = capped(fields.old_string, editLimit);
      fields.new_string = capped(fields.new_string, editLimit);
      if (fields.replace_all) fields.replace_all = { ...fields.replace_all, enum: [false] };
    }
    const required = tool.parameters.required;
    return {
      ...tool,
      description: tool.name === 'write'
        ? 'Create one missing file with a tiny complete starting document. Send file_path before content. Existing files are protected.'
        : 'Make one small exact edit to an existing file. Send file_path first. Combined old and new text must fit in 1800 characters.',
      parameters: { ...tool.parameters,
        properties: { file_path: { ...file_path, description: 'Send this file path first.' }, ...fields },
        ...(Array.isArray(required) ? { required: ['file_path', ...required.filter(key => key !== 'file_path')] } : {}),
      },
    };
  });
}

function fits(text, limit) {
  return typeof text === 'string' && text.length <= limit && Buffer.byteLength(text) <= limit * 2;
}

export function guardFileRecovery(file, execution) {
  if (!fileTools.has(execution.name)) return;
  const args = execution.arguments ?? {};
  const create = execution.name === 'write';
  if (typeof args.file_path !== 'string' || !args.file_path.trim() || (create ? !fits(args.content, writeLimit(file)) :
    !fits(args.old_string, editLimit) || !fits(args.new_string, editLimit) ||
    !fits(args.old_string + args.new_string, editLimit) || !args.old_string || args.replace_all === true)) {
    return 'File recovery needs one small complete write or exact edit. Keep the path first and split the change.';
  }
  const key = fileMutationKey(execution);
  if (file.committed.has(key) || file.pending.has(key)) {
    return 'This identical change is already committed or in progress. Read the current file before making the next edit.';
  }
  if (file.committed.size + file.pending.size >= 4096) {
    return 'File recovery reached its change tracking limit. Report the remaining work.';
  }
  file.pending.add(key);
  admitted.set(execution.token, { file, key, create });
}

function fileMutationKey({ name, arguments: args }) {
  const text = name === 'write' ? [args.content] : [args.old_string, args.new_string];
  return createHash('sha256').update(JSON.stringify([name, path.normalize(args.file_path), ...text])).digest('hex');
}

export function observeFileRecovery(file, execution, result) {
  // Only calls admitted by the recovery guard can advance this plan.
  const admission = admitted.get(execution.token);
  if (admission?.file !== file) return false;
  admitted.delete(execution.token);
  const { key } = admission;
  file.pending.delete(key);
  if (result.isError) return false;
  const value = result.value;
  const changed = value?.changed === true || (typeof value?.path === 'string' && typeof value.after === 'string' &&
    (value.operation === 'create' || typeof value.before === 'string' && value.before !== value.after));
  if (!changed) return false;
  file.committed.add(key);
  file.confirmed = true;
  return true;
}
