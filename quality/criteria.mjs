import {createHash} from 'node:crypto';

export const MAX_CRITERIA = 8;
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => { throw Object.assign(new Error(message), {code:'INVALID_CRITERIA'}); };

// Optional metadata: it neither admits another command nor replaces requiredKinds.
export function validateCriteria(criteria, checks) {
  if (criteria === undefined) return [];
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > MAX_CRITERIA) invalid('Declare 1–8 completion criteria, usually 2–4.');
  const known = new Set((checks ?? []).map(check => check.id)), ids = new Set();
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion) || Object.keys(criterion).some(key => !['id','text','checkIds'].includes(key))) invalid('A criterion uses only id, text and checkIds.');
    if (!id(criterion.id) || ids.has(criterion.id)) invalid('Criteria need unique lowercase ids.');
    ids.add(criterion.id);
    if (typeof criterion.text !== 'string' || criterion.text !== criterion.text.trim() || !criterion.text.length || criterion.text.length > 240 || /[\x00-\x1f\x7f]/u.test(criterion.text)) invalid('Criterion text must be a short nonempty single line, up to 240 characters.');
    if (!Array.isArray(criterion.checkIds) || !criterion.checkIds.length || criterion.checkIds.length > 32 || new Set(criterion.checkIds).size !== criterion.checkIds.length || criterion.checkIds.some(value => !id(value) || !known.has(value))) invalid('Each criterion must reference unique existing check ids.');
  }
  return criteria;
}

function evidence(check, declared, state) {
  const measured = check?.countsMeasured === true && Number.isSafeInteger(check.checksTotal) && check.checksTotal > 0 && Number.isSafeInteger(check.checksPassed) && check.checksPassed >= 0 && check.checksPassed <= check.checksTotal;
  return {
    id:declared.id, kind:declared.kind, state,
    checksPassed:measured ? check.checksPassed : null,
    checksTotal:measured ? check.checksTotal : null,
    // Detailed logs/artifacts remain once in the report's existing results /
    // compact checks, joined by id. Do not multiply potentially large paths.
  };
}

// currentSourceHash must come from the caller's actual current fingerprint.
// A declared criterion is verified by its mapped checks, not by its own text.
export function projectCriteria(contract, report, currentSourceHash) {
  const criteria = validateCriteria(contract.criteria, contract.checks);
  if (!criteria.length) return [];
  let eligibility = 'unknown';
  if (report?.stale === true) eligibility = 'stale';
  else if (hash(currentSourceHash) && hash(report?.sourceHash) && (report.sourceHash !== currentSourceHash || hash(report.initialSourceHash) && report.initialSourceHash !== report.sourceHash || hash(report.contractHash) && report.contractHash !== digest(contract))) eligibility = 'stale';
  else if (report?.checkId === undefined && hash(currentSourceHash) && report?.stale === false && report.sourceHash === currentSourceHash && report.initialSourceHash === currentSourceHash && report.contractHash === digest(contract) && Array.isArray(report.results)) eligibility = 'current';
  return criteria.map(criterion => {
    const checks = criterion.checkIds.map(checkId => {
      const declared = contract.checks.find(check => check.id === checkId), rows = Array.isArray(report?.results) ? report.results.filter(check => check?.id === checkId) : [];
      const check = Array.isArray(rows) && rows.length === 1 && rows[0].kind === declared.kind ? rows[0] : null;
      let state = eligibility === 'current' ? 'unknown' : eligibility;
      if (eligibility === 'current' && check) {
        if (check.passed === false) state = 'failed';
        else if (check.passed === true && check.exitCode === 0 && check.countsMeasured === true && Number.isSafeInteger(check.checksTotal) && check.checksTotal > 0 && check.checksPassed === check.checksTotal) state = 'verified';
      }
      return evidence(check, declared, state);
    });
    return {
      id:criterion.id, text:criterion.text,
      state:eligibility !== 'current' ? eligibility : checks.some(check => check.state === 'failed') ? 'failed' : checks.every(check => check.state === 'verified') ? 'verified' : 'unknown',
      sourceHash:hash(report?.sourceHash) ? report.sourceHash : null,
      observedAt:Number.isSafeInteger(report?.finishedAt) && report.finishedAt > 0 ? report.finishedAt : null,
      checks,
    };
  });
}

// Public metadata is bounded again at Native/manager handoffs. The runner's
// fingerprint stays intact; projectSourceHash identifies the manager's wider
// authoritative project snapshot, which uses a different hashing scope.
export function finalizeCriteria(report, {projectSourceHash, outcome='unknown'} = {}) {
  if (!Array.isArray(report?.criteria) || report.criteria.length > MAX_CRITERIA || !Array.isArray(report?.checks)) return [];
  const raw = report.criteria;
  // A kind-only run can legitimately omit declared checks from its results.
  // Validate declarations first, then match each result separately.
  try { validateCriteria(raw.map(row => ({id:row?.id,text:row?.text,checkIds:row?.checks?.map(check => check?.id)})), raw.flatMap(row => row.checks)); }
  catch { return []; }
  if (raw.some(row => row.checks.some(check => !['test','build','browser','acceptance'].includes(check.kind)))) return [];
  const runnerHash = report.runnerSourceHash ?? report.sourceHash;
  return raw.map(row => {
    const current = report.checkId === undefined && outcome === 'current' && report.stale === false && hash(projectSourceHash) && hash(runnerHash) && row.sourceHash === runnerHash;
    const fallback = outcome === 'stale' || report.stale === true ? 'stale' : 'unknown';
    const checks = row.checks.map(item => {
      const rows = report.checks.filter(check => check?.id === item.id), check = rows.length === 1 && rows[0].kind === item.kind ? rows[0] : null;
      const measured = check?.countsMeasured === true && Number.isSafeInteger(check.checksTotal) && check.checksTotal > 0 && Number.isSafeInteger(check.checksPassed) && check.checksPassed >= 0 && check.checksPassed <= check.checksTotal;
      const state = !current ? fallback : item.state === 'verified' && check?.passed === true && measured && check.checksPassed === check.checksTotal ? 'verified' : item.state === 'failed' && check?.passed === false ? 'failed' : 'unknown';
      return {id:item.id,kind:check?.kind ?? item.kind,state,checksPassed:measured?check.checksPassed:null,checksTotal:measured?check.checksTotal:null};
    });
    return {id:row.id,text:row.text,state:!current?fallback:checks.some(check=>check.state==='failed')?'failed':checks.every(check=>check.state==='verified')?'verified':'unknown',sourceHash:hash(row.sourceHash)?row.sourceHash:null,projectSourceHash:hash(projectSourceHash)?projectSourceHash:null,observedAt:Number.isSafeInteger(row.observedAt)&&row.observedAt>0?row.observedAt:null,checks};
  });
}

// Review reads current declarations and compares the last ordinary SDK
// result with the current project. It never loads diagnostic rerun reports.
export function visibleCriteria(contract, verification, currentSourceHash) {
  const currentContractHash = digest(contract);
  return projectCriteria(contract, null).map(declared => {
    const prior = verification?.criteria?.find?.(row => row.id === declared.id && row.text === declared.text);
    if (!prior || !Array.isArray(prior.checks) || prior.checks.length !== declared.checks.length ||
        prior.checks.some((check, index) => check.id !== declared.checks[index].id || check.kind !== declared.checks[index].kind))
      return declared;
    const sourceHash = verification.sourceHash;
    const bound = hash(sourceHash) && hash(verification.criteriaContractHash) && prior.projectSourceHash === sourceHash;
    if (!bound || !hash(currentSourceHash)) return declared;
    const stale = sourceHash !== currentSourceHash || verification.criteriaContractHash !== currentContractHash;
    const checks = declared.checks.map((check, index) => {
      const previous = prior.checks[index];
      const measured = Number.isSafeInteger(previous.checksTotal) && previous.checksTotal > 0 &&
        Number.isSafeInteger(previous.checksPassed) && previous.checksPassed >= 0 && previous.checksPassed <= previous.checksTotal;
      const state = previous.state === 'stale' || stale && ['verified','failed'].includes(previous.state) ? 'stale' :
        previous.state === 'failed' ? 'failed' :
        previous.state === 'verified' && measured && previous.checksPassed === previous.checksTotal ? 'verified' : 'unknown';
      return {...check, state, checksPassed:measured ? previous.checksPassed : null, checksTotal:measured ? previous.checksTotal : null};
    });
    const states = checks.map(check => check.state);
    const state = states.includes('stale') ? 'stale' : states.includes('failed') ? 'failed' : states.every(value => value === 'verified') ? 'verified' : 'unknown';
    return {...declared, state, checks, projectSourceHash:sourceHash,
      observedAt:Number.isSafeInteger(prior.observedAt) && prior.observedAt > 0 ? prior.observedAt : null};
  });
}
