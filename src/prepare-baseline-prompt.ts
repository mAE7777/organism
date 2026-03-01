import { resolve, join } from 'path';
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const ROOT_DIR = resolve(import.meta.dirname, '..');

function loadInputs(): Array<{ name: string; content: string }> {
  const inputDir = join(ROOT_DIR, 'inputs');
  const files = readdirSync(inputDir).filter(f => f.endsWith('.md')).sort();
  return files.map(f => ({
    name: f.replace('.md', ''),
    content: readFileSync(join(inputDir, f), 'utf-8'),
  }));
}

function main() {
  const args = process.argv.slice(2);
  const countArg = args.indexOf('--count');
  const count = countArg !== -1 && args[countArg + 1] ? parseInt(args[countArg + 1], 10) : 10;
  const outputArg = args.indexOf('--output');
  const outputPath = outputArg !== -1 && args[outputArg + 1] ? args[outputArg + 1] : null;

  const allInputs = loadInputs();
  const inputs = allInputs.slice(0, count);

  let concatenated = '';
  for (let i = 0; i < inputs.length; i++) {
    concatenated += `--- INPUT ${i + 1}: ${inputs[i].name} ---\n\n`;
    concatenated += inputs[i].content.trim();
    concatenated += '\n\n';
  }

  const prompt = `I'm giving you ${inputs.length} short texts from different domains.

After reading all of them:
1. Identify the top cross-domain bridge concepts — structural similarities connecting 3+ domains
2. For each bridge, explain what structural property it captures
3. Find non-obvious transitive connections: A → B through C
4. Generate questions arising from structural tensions between the inputs

Be specific — name the structural mechanism, not just "these are similar."

${concatenated}`;

  if (outputPath) {
    writeFileSync(outputPath, prompt);
    console.log(`Prompt written to ${outputPath} (${prompt.length} chars, ~${Math.round(prompt.length / 4)} tokens)`);
  } else {
    console.log(prompt);
  }

  // Also output just the concatenated inputs for use as cache-friendly context block
  if (args.includes('--context-only')) {
    const contextPath = outputPath ? outputPath.replace('.txt', '-context.txt') : null;
    if (contextPath) {
      writeFileSync(contextPath, concatenated);
      console.log(`Context block written to ${contextPath}`);
    } else {
      console.log('\n\n=== CONTEXT BLOCK (for prompt caching) ===\n');
      console.log(concatenated);
    }
  }
}

main();
