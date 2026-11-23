# **Prototype build guide: Lean 4 → WASM → TypeScript**

We're going to build a small but real prototype of a **formally verified mathematical engine that runs inside your TypeScript web app through WebAssembly**.

We'll keep the prototype intentionally small so we can prove the architecture works before expanding it into a full calculation library.

## **Our end goal**

You will be able to call this from TypeScript:

```
const result = await math.pnl({
  entryPrice: 100_000n,
  exitPrice: 105_000n,
  quantity: 2n,
})

console.log(result)
// 10000n
```

The calculation itself will run inside the Lean-derived WASM module—not inside TypeScript.

We'll build these three functions:

| Function | Description                      |
| -------- | -------------------------------- |
| `pnl`    | Calculate gross profit/loss      |
| `fee`    | Calculate trading fees           |
| `netPnL` | Calculate profit/loss after fees |

We'll also prove the mathematical properties of those functions in Lean.

# **Prototype roadmap**

1. **Phase 0 — Environment**

   Install Lean, toolchain, Node.js, TypeScript

2. **Phase 1 — Lean project**

   Set up the mathematical package

3. **Phase 2 — Specifications**

   Implement PnL, fees, and net PnL

4. **Phase 3 — Proofs**

   Prove the mathematical properties

5. **Phase 4 — WASM compilation**

   Compile the executable Lean functions to WebAssembly

6. **Phase 5 — WASM runtime**

   Expose functions to JavaScript

7. **Phase 6 — TypeScript wrapper**

   Create the typed application API

8. **Phase 7 — Web Worker**

   Run calculations without blocking the UI

9. **Phase 8 — Testing**

   Compare behavior, property tests, and edge cases

10. **Phase 9 — CI**

    Automate proof and integration checks

We'll proceed one phase at a time. Don't skip ahead; each phase will leave us with something working.

# **Phase 0 — Environment setup**

## **Step 0.1 — Check your existing tools**

Open your terminal.

Check Node.js:

```
node --version
npm --version
```

Check TypeScript:

```
npx tsc --version
```

Check your C compiler (optional for this phase):

```
cc --version
```

For our browser integration, Node and npm are important. We don't need to write C manually for the Lean math engine.

## **Step 0.2 — Install Lean 4**

Lean uses a version manager called `elan`.

### **macOS / Linux**

```
curl https://elan-init.sh -sSf | sh
```

Follow the installer prompts.

Restart your terminal, or reload your shell configuration.

Then check:

```
elan --version
lean --version
lake --version
```

You should have all three commands available:

- `elan` — manages Lean versions
- `lean` — compiler, elaborator, and theorem checker
- `lake` — project and build system

If any command isn't found, don't continue until the PATH is fixed.

## **Step 0.3 — Install VS Code extension**

If you use VS Code, install:

**Lean 4**

Search for `Lean 4` in the Extensions panel.

This is important because Lean is interactive. You'll see proof states, errors, goals, and theorem suggestions directly inside the editor.

[Proofs in Lean | CS 22 Lean Reference](https://images.openai.com/static-rsc-4/b_WFDUnNt2NAF2RVW3cFrUmgYFrHPXjuozV3r5tLF7LTYSMZqvRaLgLeE_8TNWrun--mrKLbx15PtfRThVEkL52IQcmm4A2mQkxFFrnio5yDB2kfW5QjUmdONfic7rUUHzlbgZidzXHTfaXhKapM6gODhkUnL4LEq75bzc9k6wU?purpose=inline)

[A Lean Syntax Primer — overreacted](https://images.openai.com/static-rsc-4/U6wQ1dbn8nkQdIOzPANlNXyC7hzOJhjCaRQJhCsCnRcVBcurwiNewsaS3b8YEycE-ovZC_fuCK-ANAXrLfwGP9uqB2cWse4CwHHatv3k76jfKM2si76q_in5jZjUyIwQldWzgtXTCGwRKy4Xp5zuJArrwcEjyv6ZkaMIiUtWhaw?purpose=inline)

[Lean: Machine-Checked Mathematics](https://images.openai.com/static-rsc-4/rfNK-5PCGZB7KCenpEZBzvOmGapC0whDCRVLexI46jAktOMroAZTYOeZj9TOYA9VtaMauu913GXXrKurbega9eaTZPz_uscMi2yVKe9p-z17GKrXwC4HCLjj_yAQJxFoUsbcrSbK9K1-dNQX1329eUrcfjFUxftIafdTcQi9_Zk?purpose=inline)

5

When you open a `.lean` file, the Lean Infoview should display the current theorem state.

## **Step 0.4 — Verify Lean is working**

Create a temporary file:

```
mkdir lean-test
cd lean-test
```

Create `Hello.lean`:

```
#eval 1 + 1

theorem simpleProof : 1 + 1 = 2 := by
  rfl
```

Run:

```
lean Hello.lean
```

Expected:

```
2
```

No errors should appear.

You just executed Lean code and verified a theorem.

## **Step 0.5 — Understand the difference between execution and proof**

This:

```
#eval 1 + 1
```

executes a calculation.

This:

```
theorem simpleProof : 1 + 1 = 2 := by
  rfl
```

asks Lean to prove a mathematical statement.

Both are important, but they serve different purposes.

Our engine will eventually contain executable functions and proofs about those functions.

## **Important architecture correction before we proceed**

After looking at the available Lean-to-WASM ecosystem, I want to make the prototype realistic rather than lead you down an outdated compiler route.

There are two different approaches:

1. **Run the Lean compiler/interpreter inside WASM in your browser**, then execute Lean calculations there. This is currently the more practical prototype route.
2. **Compile Lean calculation code itself into standalone WASM exports**. This is more like a conventional WASM math library, but the available direct compiler tooling is experimental. One existing `lean2wasm` project is explicitly experimental and based on older Lean versions.&#x20;

   [image](https://www.google.com/s2/favicons?domain=https://reservoir.lean-lang.org&sz=32)

   Reservoir+2

For this prototype, we'll use the first route. It still executes Lean inside WebAssembly in the browser, and Lean remains responsible for evaluating the mathematical functions. We'll build a thin interface around it.

Later, we can investigate a standalone compiled module for better startup size and performance.

# **Phase 1 — Create the project**

## **Step 1.1 — Create the project directory**

Choose a new directory for the prototype:

```
mkdir lean-wasm-math
cd lean-wasm-math
```

Initialize Git:

```
git init
```

Create a TypeScript frontend:

```
npm create vite@latest . -- --template vanilla-ts
```

Choose the Vanilla TypeScript template if prompted.

Install dependencies:

```
npm install
```

Start the frontend:

```
npm run dev
```

Open the local URL Vite gives you.

You should see the Vite starter application.

## **Step 1.2 — Create our project structure**

Replace the starter structure with this organization:

```
lean-wasm-math/
│
├── src/
│   ├── main.ts
│   ├── style.css
│   │
│   ├── lean/
│   │   ├── lean-runtime.ts
│   │   ├── lean-worker.ts
│   │   └── lean-client.ts
│   │
│   ├── math/
│   │   ├── types.ts
│   │   ├── pnl.ts
│   │   ├── fees.ts
│   │   └── net-pnl.ts
│   │
│   └── ui/
│       └── calculator.ts
│
├── lean/
│   ├── lean-toolchain
│   ├── lakefile.toml
│   ├── Main.lean
│   └── VerifiedMath/
│       ├── PnL.lean
│       ├── Fees.lean
│       └── NetPnL.lean
│
├── public/
│   └── lean-wasm/
│
├── tests/
│
├── package.json
├── tsconfig.json
└── README.md
```

Create the directories:

```
mkdir -p src/lean src/math src/ui
mkdir -p lean/VerifiedMath
mkdir -p public/lean-wasm
mkdir -p tests
```

We are separating the mathematical definitions from the runtime interface.

## **Step 1.3 — Initialize the Lean package**

Go into the Lean directory:

```
cd lean
```

Create a Lake project:

```
lake init VerifiedMath
```

Depending on the installed Lean version, Lake may generate a starter project and files. We'll organize the generated files into our structure afterward.

Pin the Lean version.

Check your installed version:

```
lean --version
```

Then write that version into `lean-toolchain`.

For example, if your installed version is `leanprover/lean4:v4.XX.X`, use the exact version string reported by the toolchain rather than blindly copying this placeholder.

```
leanprover/lean4:v4.XX.X
```

This ensures that everyone building the project uses the same Lean version.

# **Phase 2 — Install the Lean WASM runtime**

For the initial prototype, we'll test `lean4.js`, which provides a JavaScript interface to a Lean 4 WebAssembly runtime.

It exposes a basic API:

```
const lean = new Lean4()

await lean.init()

const result = await lean.run(`
  #eval 2 + 2
`)

console.log(result.stdout)
```

It can execute Lean code and return output to JavaScript. Its current implementation has a substantial runtime download and startup cost, so we'll use it to validate our architecture rather than assume it's production-ready.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

timqian/lean4.js · GitHub

## **Step 2.1 — Install the dependency**

From the project root:

```
npm install lean4.js
```

## **Step 2.2 — Configure Vite**

Open `vite.config.ts`.

Replace it with:

```
import { defineConfig } from 'vite'
import { lean4Plugin } from 'lean4.js/vite'

export default defineConfig({
  plugins: [
    lean4Plugin(),
  ],
})
```

This plugin configures the headers required by the runtime's `SharedArrayBuffer` support.

## **Step 2.3 — Create a Lean runtime loader**

Create:

`src/lean/lean-runtime.ts`

```
import { Lean4 } from 'lean4.js'

export type LeanRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export class LeanRuntime {
  private instance: Lean4 | null = null
  private initializing: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this.instance) return

    if (this.initializing) {
      return this.initializing
    }

    this.initializing = this.initializeInternal()

    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  private async initializeInternal(): Promise<void> {
    const lean = new Lean4()

    await lean.init()

    this.instance = lean
  }

  async execute(code: string): Promise<LeanRunResult> {
    await this.initialize()

    if (!this.instance) {
      throw new Error('Lean runtime is not initialized')
    }

    return this.instance.run(code)
  }

  dispose(): void {
    this.instance?.dispose()
    this.instance = null
  }
}

export const leanRuntime = new LeanRuntime()
```

This gives us:

- Lazy initialization
- Single initialization even if multiple calls happen concurrently
- A reusable runtime instance
- A single execution interface
- Cleanup

# **Phase 3 — Write your mathematical engine in Lean**

This is the most important phase.

We will use integer arithmetic for our prototype. This means the values represent scaled units, not floating-point dollars.

For example:

| Real value | Internal representation |
| ---------- | ----------------------- |
| $100.00    | `10000`                 |
| $100.50    | `10050`                 |
| $105.00    | `10500`                 |
| 0.10% fee  | `10` basis points       |

We will use a price scale of 100 and fee rates in basis points. For simplicity, the calculations will use integer arithmetic, with the rounding behavior explicitly defined.

## **Step 3.1 — Create the PnL module**

Create:

`lean/VerifiedMath/PnL.lean`

```
namespace VerifiedMath.PnL

/-- Gross profit/loss for a position. -/
def calculate
    (entryPrice exitPrice quantity : Int) : Int :=
  (exitPrice - entryPrice) * quantity

/-- PnL is zero when entry and exit prices are equal. -/
theorem zero_when_prices_equal
    (price quantity : Int) :
    calculate price price quantity = 0 := by
  simp [calculate]

/-- A long position profits when price increases
    and quantity is positive. -/
theorem long_profit_when_price_increases
    (entryPrice exitPrice quantity : Int)
    (hPrice : entryPrice < exitPrice)
    (hQuantity : 0 < quantity) :
    0 < calculate entryPrice exitPrice quantity := by
  unfold calculate
  exact mul_pos (sub_pos.mpr hPrice) hQuantity

/-- A long position loses when price decreases
    and quantity is positive. -/
theorem long_loss_when_price_decreases
    (entryPrice exitPrice quantity : Int)
    (hPrice : exitPrice < entryPrice)
    (hQuantity : 0 < quantity) :
    calculate entryPrice exitPrice quantity < 0 := by
  unfold calculate
  exact mul_neg_of_pos_of_neg
    hQuantity
    (sub_neg.mpr hPrice)

end VerifiedMath.PnL
```

Notice that the theorems don't specify particular prices.

They apply to all integer prices and quantities satisfying the conditions.

That's the power of formal verification.

## **Step 3.2 — Create the fees module**

Create:

`lean/VerifiedMath/Fees.lean`

```
namespace VerifiedMath.Fees

/-- Fee rate in basis points.
    10,000 basis points = 100%. -/
def calculate
    (notional feeRateBps : Int) : Int :=
  notional * feeRateBps / 10_000

/-- Zero notional produces zero fees. -/
theorem zero_when_notional_zero
    (feeRateBps : Int) :
    calculate 0 feeRateBps = 0 := by
  simp [calculate]

/-- Zero fee rate produces zero fees. -/
theorem zero_when_rate_zero
    (notional : Int) :
    calculate notional 0 = 0 := by
  simp [calculate]

end VerifiedMath.Fees
```

The division is integer division.

That means rounding is part of our specification. Before using this for actual trading, we will explicitly decide whether fees round up, round down, or use another exchange-specific policy.

## **Step 3.3 — Create net PnL**

Create:

`lean/VerifiedMath/NetPnL.lean`

```
namespace VerifiedMath.NetPnL

def calculate
    (grossPnL fees : Int) : Int :=
  grossPnL - fees

theorem net_equals_gross_minus_fees
    (grossPnL fees : Int) :
    calculate grossPnL fees = grossPnL - fees := by
  rfl

theorem fees_reduce_profit
    (grossPnL fees : Int)
    (hFees : 0 < fees) :
    calculate grossPnL fees < grossPnL := by
  unfold calculate
  omega

end VerifiedMath.NetPnL
```

This theorem establishes that positive fees reduce net PnL.

## **Step 3.4 — Create a combined Lean entry file**

Create:

`lean/Main.lean`

```
import VerifiedMath.PnL
import VerifiedMath.Fees
import VerifiedMath.NetPnL

namespace VerifiedMath

def calculateFullPnL
    (entry exit quantity feeRateBps : Int) : Int :=
  let gross := PnL.calculate entry exit quantity
  let notional := exit * quantity
  let fees := Fees.calculate notional feeRateBps

  NetPnL.calculate gross fees

end VerifiedMath

#eval VerifiedMath.PnL.calculate 10000 10500 2

#eval VerifiedMath.Fees.calculate 21000 10

#eval VerifiedMath.calculateFullPnL 10000 10500 2 10
```

Expected calculations:

```
1000
21
979
```

The exact numbers here represent scaled units. We are not converting them into a decimal currency display yet.

# **Phase 4 — Prove and build your Lean package**

## **Step 4.1 — Build the Lean modules**

From the project root:

```
cd lean
lake build
```

If Lake reports missing modules or package configuration errors, we will fix the project configuration before proceeding.

## **Step 4.2 — Run the main file**

```
lake env lean Main.lean
```

You should see the evaluated results.

If there are theorem errors, Lean will stop and report them.

## **Step 4.3 — Test a deliberately incorrect theorem**

Temporarily add:

```
theorem incorrect :
    (1 : Int) = 2 := by
  rfl
```

Lean should reject it.

That is our first demonstration that the proof checker is actually enforcing correctness.

Remove the theorem after verifying that it fails.

# **Phase 5 — Execute Lean from TypeScript**

Now we connect the mathematical engine to the application.

## **Step 5.1 — Create the Lean code payload**

Create:

`src/lean/pnl-code.ts`

```
export const pnlLeanCode = `
namespace VerifiedMath

def pnl (entry exit quantity : Int) : Int :=
  (exit - entry) * quantity

theorem pnl_zero
    (entry quantity : Int) :
    pnl entry entry quantity = 0 := by
  simp [pnl]

theorem pnl_positive
    (entry exit quantity : Int)
    (hPrice : entry < exit)
    (hQuantity : 0 < quantity) :
    0 < pnl entry exit quantity := by
  unfold pnl
  exact mul_pos (sub_pos.mpr hPrice) hQuantity

def fee (notional rateBps : Int) : Int :=
  notional * rateBps / 10000

def netPnL (gross fees : Int) : Int :=
  gross - fees

def calculate
    (entry exit quantity rateBps : Int) : Int :=
  let gross := pnl entry exit quantity
  let notional := exit * quantity
  let fees := fee notional rateBps

  netPnL gross fees

end VerifiedMath

#eval VerifiedMath.pnl 10000 10500 2
#eval VerifiedMath.fee 21000 10
#eval VerifiedMath.calculate 10000 10500 2 10
`
```

This contains the Lean definitions, theorem, and executable calculations.

Note that this is a prototype technique: we're loading a Lean program into the WASM Lean runtime. We haven't yet created a separately compiled WASM module containing native exports for `pnl`, `fee`, and `netPnL`.

## **Step 5.2 — Create a test button**

Replace `src/main.ts`:

```
import './style.css'

import { leanRuntime } from './lean/lean-runtime'
import { pnlLeanCode } from './lean/pnl-code'

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

app.innerHTML = `
  <main>
    <h1>Verified Math</h1>

    <p>
      Lean 4 running through WebAssembly
    </p>

    <button id="run">
      Run Lean calculation
    </button>

    <pre id="output"></pre>
  </main>
`

const button = document.querySelector<HTMLButtonElement>('#run')
const output = document.querySelector<HTMLPreElement>('#output')

button?.addEventListener('click', async () => {
  if (!output) return

  button.disabled = true
  output.textContent = 'Initializing Lean WASM runtime...'

  try {
    const result = await leanRuntime.execute(pnlLeanCode)

    output.textContent = [
      `Exit code: ${result.exitCode}`,
      '',
      'STDOUT:',
      result.stdout,
      '',
      'STDERR:',
      result.stderr,
    ].join('\n')
  } catch (error) {
    output.textContent = error instanceof Error
      ? error.message
      : String(error)
  } finally {
    button.disabled = false
  }
})
```

## **Step 5.3 — Start the application**

```
npm run dev
```

Click **Run Lean calculation**.

The first run may take significantly longer than subsequent calls due to downloading and initializing the runtime.

You should eventually see:

```
Exit code: 0

STDOUT:
1000
21
979
```

If you get this, congratulations: your TypeScript app has successfully called Lean code running through a WebAssembly runtime.

# **Phase 6 — Create a typed TypeScript API**

We don't want your application calling `leanRuntime.execute()` directly.

We want this:

```
const pnl = await math.pnl(10000n, 10500n, 2n)
```

## **Step 6.1 — Create types**

Create:

`src/math/types.ts`

```
export type PnLInput = {
  entryPrice: bigint
  exitPrice: bigint
  quantity: bigint
}

export type FeeInput = {
  notional: bigint
  feeRateBps: bigint
}

export type NetPnLInput = {
  grossPnL: bigint
  fees: bigint
}

export type VerifiedCalculationResult<T> = {
  value: T
  engine: 'lean-wasm'
  verified: true
}
```

## **Step 6.2 — Create the PnL wrapper**

Create:

`src/math/pnl.ts`

```
import { leanRuntime } from '../lean/lean-runtime'
import type {
  PnLInput,
  VerifiedCalculationResult,
} from './types'

const LEAN_PNL = `
def verifiedPnL
    (entry exit quantity : Int) : Int :=
  (exit - entry) * quantity

theorem verifiedPnL_zero
    (entry quantity : Int) :
    verifiedPnL entry entry quantity = 0 := by
  simp [verifiedPnL]

theorem verifiedPnL_positive
    (entry exit quantity : Int)
    (hPrice : entry < exit)
    (hQuantity : 0 < quantity) :
    0 < verifiedPnL entry exit quantity := by
  unfold verifiedPnL
  exact mul_pos (sub_pos.mpr hPrice) hQuantity
`

export async function calculatePnL(
  input: PnLInput,
): Promise<VerifiedCalculationResult<bigint>> {
  const {
    entryPrice,
    exitPrice,
    quantity,
  } = input

  const code = `
${LEAN_PNL}

#eval verifiedPnL ${entryPrice} ${exitPrice} ${quantity}
`

  const result = await leanRuntime.execute(code)

  if (result.exitCode !== 0) {
    throw new Error(
      `Lean calculation failed:\n${result.stderr}`,
    )
  }

  const output = result.stdout.trim()

  const value = BigInt(output.split('\n').at(-1)!)

  return {
    value,
    engine: 'lean-wasm',
    verified: true,
  }
}
```

This is a first-pass wrapper.

Later, we will improve it with:

- Input validation
- Output protocol
- Runtime timeouts
- Error types
- Persistent worker
- Batched execution
- Runtime initialization progress
- Versioned engine
- Caching

One important detail: the `verified: true` field here means the Lean runtime executed the source containing the theorem successfully. It is not yet a production-grade certificate that every returned value was generated from a specific theorem. We will strengthen that architecture in a later phase.

## **Step 6.3 — Test the API from your frontend**

In `src/main.ts`, import the wrapper:

```
import { calculatePnL } from './math/pnl'
```

Then test:

```
const result = await calculatePnL({
  entryPrice: 10000n,
  exitPrice: 10500n,
  quantity: 2n,
})

console.log(result)
```

Expected:

```
{
  value: 1000n,
  engine: 'lean-wasm',
  verified: true,
}
```

# **Phase 7 — Add fees and net PnL**

Let's extend the engine.

Create:

`src/math/fees.ts`

```
import { leanRuntime } from '../lean/lean-runtime'
import type {
  FeeInput,
  VerifiedCalculationResult,
} from './types'

export async function calculateFee(
  input: FeeInput,
): Promise<VerifiedCalculationResult<bigint>> {
  const { notional, feeRateBps } = input

  const code = `
def verifiedFee
    (notional rateBps : Int) : Int :=
  notional * rateBps / 10000

theorem verifiedFee_zero_rate
    (notional : Int) :
    verifiedFee notional 0 = 0 := by
  simp [verifiedFee]

#eval verifiedFee ${notional} ${feeRateBps}
`

  const result = await leanRuntime.execute(code)

  if (result.exitCode !== 0) {
    throw new Error(`Lean fee calculation failed`)
  }

  const output = result.stdout.trim()
  const value = BigInt(output.split('\n').at(-1)!)

  return {
    value,
    engine: 'lean-wasm',
    verified: true,
  }
}
```

Create:

`src/math/net-pnl.ts`

```
import { leanRuntime } from '../lean/lean-runtime'
import type {
  NetPnLInput,
  VerifiedCalculationResult,
} from './types'

export async function calculateNetPnL(
  input: NetPnLInput,
): Promise<VerifiedCalculationResult<bigint>> {
  const { grossPnL, fees } = input

  const code = `
def verifiedNetPnL
    (gross fees : Int) : Int :=
  gross - fees

theorem verifiedNetPnL_definition
    (gross fees : Int) :
    verifiedNetPnL gross fees = gross - fees := by
  rfl

#eval verifiedNetPnL ${grossPnL} ${fees}
`

  const result = await leanRuntime.execute(code)

  if (result.exitCode !== 0) {
    throw new Error(`Lean net PnL calculation failed`)
  }

  const output = result.stdout.trim()
  const value = BigInt(output.split('\n').at(-1)!)

  return {
    value,
    engine: 'lean-wasm',
    verified: true,
  }
}
```

For the prototype, these are separate functions. We'll later refactor the repeated runtime calls into a single shared evaluator.

# **Phase 8 — Add an integration test**

We want to test the entire chain:

```
TypeScript input
      ↓
Lean source generation
      ↓
Lean WASM runtime
      ↓
Lean calculation
      ↓
stdout
      ↓
BigInt parsing
      ↓
TypeScript result
```

## **Step 8.1 — Add Vitest**

```
npm install -D vitest
```

Add to `package.json`:

```
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

## **Step 8.2 — Write the first test**

Create:

`tests/pnl.test.ts`

```
import { describe, expect, it } from 'vitest'

describe('PnL specification', () => {
  it('calculates positive PnL', () => {
    const entry = 10000n
    const exit = 10500n
    const quantity = 2n

    const result = (exit - entry) * quantity

    expect(result).toBe(1000n)
  })

  it('calculates negative PnL', () => {
    const entry = 10500n
    const exit = 10000n
    const quantity = 2n

    const result = (exit - entry) * quantity

    expect(result).toBe(-1000n)
  })

  it('calculates zero PnL', () => {
    const entry = 10000n
    const exit = 10000n
    const quantity = 2n

    const result = (exit - entry) * quantity

    expect(result).toBe(0n)
  })
})
```

These are ordinary tests of the specification and arithmetic expectations. They are not yet tests that execute the WASM engine.

For the actual WASM integration, we'll test in a browser environment because the runtime depends on browser-related infrastructure.

Eventually, I want these cases tested against both:

1. A reference TypeScript implementation.
2. The Lean WASM implementation.

Then we can detect discrepancies.

# **Phase 9 — Benchmark the runtime**

Before expanding this into a full math library, measure its performance.

Add a timer to the button handler:

```
const startedAt = performance.now()

const result = await leanRuntime.execute(pnlLeanCode)

const duration = performance.now() - startedAt

console.log({
  durationMs: duration,
  output: result.stdout,
  exitCode: result.exitCode,
})
```

Record these measurements:

| Measurement            | Target for prototype |
| ---------------------- | -------------------- |
| First initialization   | Measure; likely slow |
| First calculation      | Measure              |
| Subsequent calculation | Measure              |
| Runtime download size  | Measure              |
| Memory usage           | Measure              |
| Calculation output     | Exact                |

The current `lean4.js` implementation documents a substantial startup cost, including roughly a minute for a minimal Lean run in its current implementation. It also caches the runtime assets. This is precisely why we're benchmarking before committing to it for production.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

timqian/lean4.js · GitHub

For a production engine, I would want to avoid starting a Lean runtime for every calculation. We want one persistent runtime, ideally in a Worker, accepting many calculation requests.

# **Phase 10 — Establish the correctness boundary**

This is the most important design lesson of the prototype.

Suppose your TypeScript code sends:

```
{
  entryPrice: 10000n,
  exitPrice: 10500n,
  quantity: 2n,
}
```

Lean calculates:

```
(10500 - 10000) * 2
```

And returns:

```
1000
```

The Lean runtime proves your theorem:

```
theorem pnl_positive ...
```

But the theorem doesn't prove that your JavaScript parser correctly parsed the output, that the inputs represent the correct real-world units, or that your application displayed the result accurately.

We need separate verification boundaries:

**1. Mathematical correctness**

Lean proofs

Are the properties of the calculation mathematically correct?

**2. Implementation correctness**

Lean executable

Is the code we execute the same code whose properties we proved?

**3. Integration correctness**

TypeScript tests

Are the values sent and received correctly?

**4. Application correctness**

Business rules and UI tests

Are we using the correct prices, quantities, fee rates, decimal scales, and user assumptions?

The ultimate goal is to strengthen all four layers.

# **Phase 11 — Add a verification command to your workflow**

Create a root `package.json` script:

```
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest",
    "lean:check": "cd lean && lake build",
    "verify": "npm run lean:check && npm run test:run && npm run build"
  }
}
```

Now your verification workflow is:

```
npm run verify
```

This runs:

1. Lean theorem compilation
2. TypeScript tests
3. TypeScript build

For CI, this becomes the gate for your pull requests.

## **Small correction to Phase 3**

If you include the long-position loss theorem, use this corrected proof:

```
theorem long_loss_when_price_decreases
    (entryPrice exitPrice quantity : Int)
    (hPrice : exitPrice < entryPrice)
    (hQuantity : 0 < quantity) :
    calculate entryPrice exitPrice quantity < 0 := by
  unfold calculate
  rw [mul_comm]
  exact mul_neg_of_pos_of_neg
    hQuantity
    (sub_neg.mpr hPrice)
```

This makes the multiplication order explicit so Lean can apply the sign theorem correctly.

# **Prototype completion checklist**

**Prototype progress**

0/11

Lean 4 installed and working

Vite + TypeScript project created

Lean mathematical functions written

PnL theorem proofs checked

Fee and net PnL definitions created

Lean WASM runtime installed

TypeScript successfully executes Lean code

PnL result correctly returned as BigInt

Integration tests added

Runtime performance measured

Verification command added

## **The final architecture we are working toward**

```
TypeScript Application
        │
        ▼
  VerifiedMath Client
        │
        ▼
 Persistent Web Worker
        │
        ▼
 Lean WASM Runtime
        │
        ├── PnL
        ├── Fees
        ├── Net PnL
        ├── Risk Calculations
        ├── Statistical Calculations
        └── Market Indicators
```

The initial prototype validates the concept. After that, our next engineering milestone should be improving the runtime into a **persistent, reusable calculation engine**, eliminating the overhead of repeatedly initializing Lean.

I recommend following this guide one phase at a time, and starting with Phase 0 in your actual development environment. When you encounter an error, send me the terminal output and the relevant file, and we'll resolve it before moving forward.

🧪Continue Lean prototype tomorrowTap to set up
