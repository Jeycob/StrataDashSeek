import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import assets from '../examples/app-starters/starter-files.cjs';
import { WorkbenchError } from './policy.mjs';

const command = 'homeai-starter';
const descriptions = {
  'temperature-form': 'a tested single-file temperature converter',
  'csv-expense-report': 'a tested expense CSV command-line report',
};

function starterFor(messages) {
  if (!Array.isArray(messages)) return;
  const human = messages.findLast(message => message?.role === 'user' && message.source?.kind === 'user');
  if (!human?.id || !Array.isArray(human.content)) return;
  const text = human.content.filter(part => part.type === 'text')
    .map(part => part.text).join(' ').trim().slice(0, 2000);
  if (!/^(?:prosím[ ,]+)?(?:vytvoř|napiš|připrav|zpracuj|create|build|make|implement)\s/iu.test(text)) return;
  if (/(?:bez (?:předlohy|šablony)|od nuly|from scratch|without (?:a )?template)/iu.test(text)) return;
  if (/(?:převodník teplot|převodník z °c na °f|temperature (?:converter|calculator))/iu.test(text)) {
    return 'temperature-form';
  }
  if (/\bcsv\b/iu.test(text) && /(?:výdaj|expense)/iu.test(text)
      && /(?:\bcli\b|report-cli\.mjs|příkaz|command.line)/iu.test(text)
      && /(?:amount_czk|posted|pending)/iu.test(text)) return 'csv-expense-report';
}

export function createProjectStarters(manager, enabled = true) {
  const offers = new Map();
  const projectFor = agent => agent === manager.ownerAgent(agent) && manager.data.sessions[agent?.id];
  return {
    async offer({ agent, messages, turn, signal }) {
      if (!enabled || turn !== 1 || !agent || offers.has(agent.id)) return;
      const id = starterFor(messages);
      if (!id) return;
      const project = projectFor(agent);
      if (!manager.independentRecord(project)) return;
      const entries = await readdir(project.root).catch(() => null);
      if (!entries || entries.some(name => name !== '.git')) return;
      signal?.throwIfAborted();
      offers.set(agent.id, { project, id, used: false });
      return 'For this task HomeAI has ' + descriptions[id]
        + '. To copy it into this empty project, call project_exec with command "'
        + command + '" and a short description. Then inspect and adapt the project files.';
    },
    clear(id) { offers.delete(id); },
    prepare(args, execution) {
      if (typeof args?.command !== 'string' || args.command.trim() !== command) return args;
      const offer = offers.get(execution.agent?.id);
      if (!offer || offer.used || projectFor(execution.agent) !== offer.project
          || args.workdir !== undefined || args.run_in_background === true) {
        throw new WorkbenchError('PROJECT_STARTER_NOT_OFFERED', 'This starter requires an active offer in its own empty project.');
      }
      execution.signal.throwIfAborted();
      const files = assets.readStarter(offer.id);
      const source = 'console.log("Starter files: " + (' + assets.applyStarterFiles.toString()
        + ')(".", ' + JSON.stringify(files) + ').join(", "));';
      const program = deflateRawSync(source).toString('base64');
      if (program.length > 16000) throw new WorkbenchError('PROJECT_STARTER_TOO_LARGE', 'The bundled starter exceeds the executor limit.');
      offer.used = true;
      return {
        command: 'node -e "eval(require(\'node:zlib\').inflateRawSync(Buffer.from(process.argv[1], \'base64\')).toString(\'utf8\'))" ' + program,
        description: 'Apply bundled ' + offer.id + ' starter',
        timeoutMs: 10000,
      };
    },
  };
}

export function installProjectStarterDiscovery(ctx, starters) {
  ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const hint = await starters.offer(input);
    if (!hint) return decision;
    return { ...decision, messages: [...decision.messages, {
      id: randomUUID(), role: 'user', source: { kind: 'workspace-runtime' },
      content: [{ type: 'text', text: hint }],
    }] };
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') starters.clear(session.id);
  }, { global: true });
  ctx.on('agent/disposed', ({ agent }) => starters.clear(agent.id), { global: true });
}
