import { Command, Option } from 'commander';
import { runJson } from './commands/json.js';
import { runShow } from './commands/show.js';
import { runWatch } from './commands/watch.js';
import { VERSION } from './core/version.js';
import { isOcusageError } from './errors.js';
import type { CliOptions, SourceMode } from './types.js';

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 5;

interface RawCliFlags {
  json?: boolean;
  watch?: boolean;
  interval: string;
  color: boolean;
  compact?: boolean;
  source: SourceMode;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('ocusage')
    .description(
      'A colorful dashboard for your OpenAI Codex usage limits: the current 5-hour window ' +
        'and the current week, with percent used and time until reset.',
    )
    .version(VERSION, '-V, --version')
    .option('--json', 'print the usage report as JSON (no color); exit 2 on no data')
    .option('--watch', 'clear and repaint on an interval until Ctrl-C')
    .option('--interval <seconds>', 'repaint interval in seconds for --watch (min 5)', '60')
    .option('--no-color', 'disable ANSI colors')
    .option('--compact', 'one line per window, no header — good for embedding')
    .addOption(
      new Option('--source <mode>', 'which data source to use')
        .choices(['auto', 'api', 'local'])
        .default('auto'),
    )
    .addHelpText(
      'after',
      `
Examples:
  $ ocusage                      Show the colored usage dashboard
  $ ocusage --json               Machine-readable usage report for scripts
  $ ocusage --watch               Repaint every 60s until Ctrl-C
  $ ocusage --watch --interval 15 Repaint every 15s
  $ ocusage --compact             One line per window
  $ ocusage --source local        Force the local session-log snapshot
  $ ocusage --source api          Force the live service (no local fallback)
  $ ocusage --no-color            Plain text output

Data sources:
  Live data comes from the same account usage service the Codex CLI's
  /status command polls, using the login Codex already has. When it's
  unavailable (offline, signed out, an expired token), ocusage shows the
  last usage snapshot Codex saved in its session logs under ~/.codex/sessions
  (or CODEX_HOME) and marks those numbers as estimated.
`,
    );

  program.parse();
  const options = toCliOptions(program.opts<RawCliFlags>());

  if (options.json) {
    await runJson(options);
    return;
  }
  if (options.watch) {
    await runWatch(options);
    return;
  }
  await runShow(options);
}

function toCliOptions(raw: RawCliFlags): CliOptions {
  let intervalSec = Number.parseInt(raw.interval, 10);
  if (!Number.isFinite(intervalSec)) {
    intervalSec = DEFAULT_INTERVAL_SEC;
  } else if (intervalSec < MIN_INTERVAL_SEC) {
    process.stderr.write(
      `--interval below ${MIN_INTERVAL_SEC}s is clamped to ${MIN_INTERVAL_SEC}s.\n`,
    );
    intervalSec = MIN_INTERVAL_SEC;
  }

  return {
    json: Boolean(raw.json),
    watch: Boolean(raw.watch),
    intervalSec,
    noColor: raw.color === false,
    compact: Boolean(raw.compact),
    source: raw.source,
  };
}

function handleFatalError(err: unknown): never {
  if (isOcusageError(err)) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Something went wrong: ${message}\nTry re-running with --source local.\n`);
  process.exit(1);
}

main().catch(handleFatalError);
