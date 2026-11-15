const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTurn = value => Number.isSafeInteger(value) && value > 0;
const validId = value => typeof value === 'string' && value.trim().length > 0;

/** Synchronous metadata-only transition, called for the owner before step().
 * messages must come from the server session, never from model tool arguments.
 * Returns true only when steps actually reset. No policy state is resumed or
 * discarded: an existing block still requires the owner's review strategy.
 */
export function beginUserRequest(record, budget, options = {}) {
  if (!object(options)) return false;
  const { turn, messages } = options;
  if (!object(record) || !object(budget) || !validTurn(turn) || !Array.isArray(messages)
    || !Number.isSafeInteger(budget.steps) || budget.steps < 0) return false;
  // Do not fall back to an older valid ID when the latest human message lacks
  // identity. Internal notices, tool output and assistant text are not requests.
  const message = messages.findLast(value => value?.role === 'user' && value?.source?.kind === 'user');
  if (!message || !validId(message.id)) return false;
  const previous = record.budgetRequest;
  if (!object(previous) || !validTurn(previous.turn) || !validId(previous.messageId)) {
    record.budgetRequest = { turn, messageId: message.id };
    return false; // Migration/first observation cannot erase existing usage.
  }
  if (turn <= previous.turn) return false;
  // Advance the high-water mark even for an internal turn with the same human
  // ID, preventing an older provider retry from subsequently renewing a budget.
  record.budgetRequest = { turn, messageId: message.id };
  if (message.id === previous.messageId || budget.blocked) return false;
  budget.steps = 0;
  return true;
}
