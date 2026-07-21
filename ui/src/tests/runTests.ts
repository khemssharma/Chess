import ReactModule from "react";
import dotenv from "dotenv";
dotenv.config();

// Mock helper functions
const fn = (impl?: any) => {
  const mock: any = (...args: any[]) => {
    mock.mock.calls.push(args);
    return mock.mock.implementation(...args);
  };
  mock.mock = {
    calls: [] as any[][],
    implementation: impl || (() => {})
  };
  mock.mockImplementation = (newImpl: any) => {
    mock.mock.implementation = newImpl;
    return mock;
  };
  return mock;
};

const spyOn = (obj: any, method: string) => {
  const original = obj[method];
  const mockFn = fn(original);
  obj[method] = mockFn;
  return mockFn;
};

// Test registries
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
let currentDescribe = "";

const describeFn = (name: string, fn: () => void) => {
  currentDescribe = name;
  fn();
};

const itFn = (name: string, fn: () => void | Promise<void>) => {
  tests.push({ name: `${currentDescribe} > ${name}`, fn });
};

const beforeAlls: (() => void)[] = [];
const afterAlls: (() => void)[] = [];
const beforeEachs: (() => void)[] = [];
const afterEachs: (() => void)[] = [];

const beforeAllFn = (fn: () => void) => beforeAlls.push(fn);
const afterAllFn = (fn: () => void) => afterAlls.push(fn);
const beforeEachFn = (fn: () => void) => beforeEachs.push(fn);
const afterEachFn = (fn: () => void) => afterEachs.push(fn);

const expectFn = (val: any) => {
  return {
    toBe: (expected: any) => {
      if (val !== expected) throw new Error(`Expected ${val} to be ${expected}`);
    },
    toBeDefined: () => {
      if (val === undefined) throw new Error("Expected to be defined");
    },
    toBeUndefined: () => {
      if (val !== undefined) throw new Error(`Expected ${val} to be undefined`);
    },
    toEqual: (expected: any) => {
      const s1 = JSON.stringify(val);
      const s2 = JSON.stringify(expected);
      if (s1 !== s2) throw new Error(`Expected ${s1} to equal ${s2}`);
    }
  };
};

// Mock localStorage store
let mockStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockStore[key] || null,
  setItem: (key: string, value: string) => { mockStore[key] = value; },
  removeItem: (key: string) => { delete mockStore[key]; },
  clear: () => { mockStore = {}; }
};

// Set up globals
(globalThis as any).describe = describeFn;
(globalThis as any).it = itFn;
(globalThis as any).expect = expectFn;
(globalThis as any).beforeAll = beforeAllFn;
(globalThis as any).afterAll = afterAllFn;
(globalThis as any).beforeEach = beforeEachFn;
(globalThis as any).afterEach = afterEachFn;
(globalThis as any).React = ReactModule;
(globalThis as any).jest = {
  fn,
  spyOn,
  mock: () => {}
};

// Mock browser environments for Node execution
(globalThis as any).window = (globalThis as any).window || {
  location: { href: "", pathname: "" },
  localStorage: mockLocalStorage
};

// Proxy global localStorage to window.localStorage to pick up mock overrides
Object.defineProperty(globalThis, "localStorage", {
  get: () => (globalThis as any).window?.localStorage || mockLocalStorage,
  configurable: true
});

(globalThis as any).import = {
  meta: {
    env: {
      VITE_API_URL: "http://localhost:3000"
    }
  }
};

async function run() {
  // Dynamically load tests
  await import("./apiClient.test");
  await import("./authService.test");
  await import("./ProtectedRoute.test");

  console.log(`\n🚀 Starting custom test suite execution (${tests.length} tests registered)\n`);

  // Run beforeAlls
  for (const fn of beforeAlls) fn();

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    // Run beforeEachs
    for (const fn of beforeEachs) fn();

    try {
      await test.fn();
      console.log(`  ✅ PASS: ${test.name}`);
      passed++;
    } catch (err: any) {
      console.log(`  ❌ FAIL: ${test.name}`);
      console.error(err.stack || err.message || err);
      failed++;
    }

    // Run afterEachs
    for (const fn of afterEachs) fn();
  }

  // Run afterAlls
  for (const fn of afterAlls) fn();

  console.log(`\n📊 Final Results: ${passed} passed, ${failed} failed.\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(console.error);
