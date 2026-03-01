import { resolve } from 'path';
import { Runner, L2Runner, L3Runner } from './runner.js';
import { runBoundaryTest, runPathDependenceTest } from './diagnostic-tests.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    // === MVO commands (backward compatible) ===
    case 'run': {
      const runner = new Runner(ROOT_DIR);
      await runner.runAll();
      break;
    }

    case 'run-one': {
      const n = parseInt(args[0], 10);
      if (isNaN(n)) {
        console.log('Usage: run-one <number>');
        process.exit(1);
      }
      const runner = new Runner(ROOT_DIR);
      await runner.runOne(n);
      break;
    }

    case 'query': {
      const question = args.join(' ');
      if (!question) {
        console.log('Usage: query "your question"');
        process.exit(1);
      }
      const runner = new Runner(ROOT_DIR);
      await runner.runQuery(question);
      break;
    }

    case 'metrics': {
      const runner = new Runner(ROOT_DIR);
      runner.showMetrics();
      break;
    }

    case 'cost': {
      const runner = new Runner(ROOT_DIR);
      runner.showCost();
      break;
    }

    // === Level 2 commands ===
    case 'run-l2': {
      const l2 = new L2Runner(ROOT_DIR);
      await l2.runL2({
        resume: args.includes('--resume'),
        noDecay: args.includes('--no-decay'),
        dataDir: getArgValue(args, '--data-dir'),
        enrichedBaseline: args.includes('--enriched-baseline'),
      });
      break;
    }

    case 'run-l2-queries': {
      const l2 = new L2Runner(ROOT_DIR);
      await l2.runL2Queries({
        dataDir: getArgValue(args, '--data-dir'),
        enrichedBaseline: args.includes('--enriched-baseline'),
      });
      break;
    }

    case 'run-l2-analysis': {
      const l2 = new L2Runner(ROOT_DIR);
      await l2.runL2Analysis();
      break;
    }

    case 'run-l2-judge': {
      const l2 = new L2Runner(ROOT_DIR);
      await l2.runL2Judge({
        enrichedBaseline: args.includes('--enriched-baseline'),
      });
      break;
    }

    case 'run-l2-report': {
      const l2 = new L2Runner(ROOT_DIR);
      await l2.runL2Report();
      break;
    }

    // === Level 3 commands ===
    case 'run-l3': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runL3({
        resume: args.includes('--resume'),
        dataDir: getArgValue(args, '--data-dir'),
      });
      break;
    }

    case 'run-l3-evaluate': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runL3Evaluate();
      break;
    }

    case 'run-l3-report': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runL3Report();
      break;
    }

    case 'run-l3-drift-test': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runL3DriftTest();
      break;
    }

    case 'run-l3-scale-test':
    case 'run-l3-scale': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runL3ScaleTest();
      break;
    }

    case 'run-l3-fair-judge': {
      const l3 = new L3Runner(ROOT_DIR);
      await l3.runFairJudge();
      break;
    }

    // === Diagnostic tests ===
    case 'run-diagnostic-boundary': {
      await runBoundaryTest();
      break;
    }

    case 'run-diagnostic-path': {
      await runPathDependenceTest();
      break;
    }

    default:
      console.log(`Usage:
  # MVO (Level 1)
  npx tsx src/index.ts run              # run full A/B test
  npx tsx src/index.ts run-one <n>      # run single input
  npx tsx src/index.ts query "..."      # query both systems
  npx tsx src/index.ts metrics          # show topology metrics
  npx tsx src/index.ts cost             # show total API spend

  # Level 2
  npx tsx src/index.ts run-l2                       # full 50-input Level 2 run
  npx tsx src/index.ts run-l2 --resume              # resume from last completed input
  npx tsx src/index.ts run-l2 --no-decay            # 50 inputs without decay (Test 4)
  npx tsx src/index.ts run-l2 --enriched-baseline   # run with enriched System A (Test 6)
  npx tsx src/index.ts run-l2 --data-dir <dir>      # use custom data directory
  npx tsx src/index.ts run-l2-queries               # run 10 queries on both systems
  npx tsx src/index.ts run-l2-analysis              # compute emergence metrics
  npx tsx src/index.ts run-l2-judge                 # blind A/B comparison
  npx tsx src/index.ts run-l2-report                # generate full test report

  # Level 3
  npx tsx src/index.ts run-l3                       # full 50-input Level 3 run
  npx tsx src/index.ts run-l3 --resume              # resume from last completed input
  npx tsx src/index.ts run-l3 --data-dir <dir>      # use custom data directory
  npx tsx src/index.ts run-l3-evaluate              # run automated test suite (A-K)
  npx tsx src/index.ts run-l3-report                # generate final report
  npx tsx src/index.ts run-l3-drift-test            # info about drift tests
  npx tsx src/index.ts run-l3-scale                 # run Test J (topology vs enriched baseline)
  npx tsx src/index.ts run-l3-scale-test            # alias for run-l3-scale
  npx tsx src/index.ts run-l3-fair-judge            # run redesigned fair Judge (Test J)

  # Diagnostic tests
  npx tsx src/index.ts run-diagnostic-boundary      # capability boundary test (~$0.35)
  npx tsx src/index.ts run-diagnostic-path          # semantic path-dependence test (~$0.05)

  # Investigation scripts
  npx tsx src/order-test.ts                         # 10-input order sensitivity test
  npx tsx src/order-test.ts --count 50              # full 50-input order test
  npx tsx src/prepare-baseline-prompt.ts            # generate fair baseline prompt`);
  }
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
