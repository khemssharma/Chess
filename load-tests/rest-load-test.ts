/**
 * REST API load test using autocannon.
 *
 * Benchmarks the public, DB-free endpoints by default (safe to run against
 * any environment). If you point this at a server wired to a real Postgres
 * instance, set INCLUDE_AUTH=1 to also hammer /api/signup and /api/login —
 * useful for checking bcrypt cost (10 rounds, CPU-bound) and Prisma
 * connection-pool behavior under concurrent auth traffic.
 *
 * Usage:
 *   npm run loadtest:rest
 *   BASE_URL=https://your-deployed-app.com DURATION=30 CONNECTIONS=100 npm run loadtest:rest
 *   INCLUDE_AUTH=1 npm run loadtest:rest    # requires a working DATABASE_URL on the server
 */

import autocannon from "autocannon";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DURATION = parseInt(process.env.DURATION || "15", 10);
const CONNECTIONS = parseInt(process.env.CONNECTIONS || "50", 10);
const INCLUDE_AUTH = process.env.INCLUDE_AUTH === "1";

function run(opts: autocannon.Options): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: true });
  });
}

function printSummary(name: string, result: autocannon.Result) {
  console.log(`\n=== ${name} ===`);
  console.log(`Requests/sec:  avg=${result.requests.average} p99=${result.requests.p99}`);
  console.log(`Latency (ms):  avg=${result.latency.average} p50=${result.latency.p50} p99=${result.latency.p99} max=${result.latency.max}`);
  console.log(`Throughput:    ${(result.throughput.average / 1024).toFixed(1)} KB/s`);
  console.log(`Non-2xx/errors: ${result.non2xx} 2xx-mismatch, ${result.errors} conn errors, ${result.timeouts} timeouts`);
}

async function main() {
  console.log(`REST scalability test`);
  console.log(`  target:       ${BASE_URL}`);
  console.log(`  duration:     ${DURATION}s per scenario`);
  console.log(`  connections:  ${CONNECTIONS}`);

  const leaderboard = await run({
    url: `${BASE_URL}/api/leaderboard?type=game`,
    connections: CONNECTIONS,
    duration: DURATION,
  });
  printSummary("GET /api/leaderboard", leaderboard);

  if (INCLUDE_AUTH) {
    // Each connection signs up a unique user, then logs in repeatedly.
    // This exercises bcrypt (CPU) + Prisma (DB pool) under real concurrency.
    let counter = 0;
    const signup = await run({
      url: `${BASE_URL}/api/signup`,
      method: "POST",
      headers: { "content-type": "application/json" },
      connections: CONNECTIONS,
      duration: DURATION,
      setupClient: (client) => {
        client.setBody(
          JSON.stringify({
            username: `loadtest_${Date.now()}_${counter}`,
            email: `loadtest_${Date.now()}_${counter++}@example.com`,
            password: "LoadTest123!",
          })
        );
      },
    });
    printSummary("POST /api/signup (bcrypt + DB write)", signup);
  } else {
    console.log(
      "\n(Skipped /api/signup and /api/login — set INCLUDE_AUTH=1 with a real DATABASE_URL to include them.)"
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("REST load test failed:", err);
  process.exit(1);
});
