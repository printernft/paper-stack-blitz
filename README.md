# Paper Stack Daily Challenge

A playable Printer World entry candidate for MagicBlock Solana Blitz v10. Fill three print orders from the same draw as everyone else, then send a friend your scorecard to beat.

## What to try

1. Read the three orders above the stack. Each gives you two sheets. The shared draw sets the sequence, slide speed, perfect-drop tolerance, and time limit.
2. Play a round and save your score. Open the scorecard link in a fresh tab to play the same draw with that score to beat.
3. Open the run check to see how the saved drop timings reproduce the score. In a verified challenge, use **Verified draw** at the top of the game to find the devnet transaction.

## Local practice

Open [Paper-Stack-MagicBlock-Local.html](Paper-Stack-MagicBlock-Local.html) on Windows for the offline, co-branded walkthrough. The HTML contains the game and its assets. Scores stay in the current tab. Regenerate it with `node scripts/export-local.mjs` after editing the page.

[Paper-Stack-Playtest.mp4](Paper-Stack-Playtest.mp4) shows the desktop four-sheet run, the phone-emulated seven-sheet rematch, and the run check. The rehearsal uses a practice draw.

Run `npm start` with Node.js 22 or newer, then open `http://127.0.0.1:19918/`. The game server needs no npm packages. `npm test` covers shared seeds, server scoring, scorecard persistence, idempotent retries, and proof rejection.

Play with Space, the Drop sheet button, or a tap on the tower. Each print order lasts two sheets. The draw sets the job sequence and the speed boost for Rush, the perfect-drop window for Fine Cut, and the time limit for Quick Dry. The browser and server use the same rules. Copy a saved run's scorecard link to share its score. The receiver can replay the recorded drop timings in the browser to check that they produce the same score. A practice challenge uses a deterministic local seed for its UTC date and shows a practice label.

## Devnet proof

The prepared program follows the [MagicBlock VRF quickstart](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart). It allocates one account per UTC day. It accepts one request per account and stores the random bytes only through MagicBlock's program-scoped signer. The server reads the seed account and finalized callback from devnet and verifies the callback invocation and seed before the interface displays a Solana Explorer link. The game server checks drop timing and calculates scores using the original Paper Stack rules.

The program still needs a successful Anchor build and a finalized devnet callback. Use an isolated Anchor build host with devnet access and a faucet-funded test payer. Once verified, the app shows the Explorer transaction next to the draw and the run check.

1. Prepare Solana CLI 3.1.9, Rust 1.89 and Anchor CLI 1.0.2. From the project root, run `node scripts/devnet-build.mjs`. It creates or reuses the local program key, syncs the address and builds the program and IDL.
2. Create `.runtime/` and generate a dedicated test payer with `solana-keygen new -o .runtime/devnet-payer.json`. Check the deployment size and faucet balance. After authorization, deploy with `anchor deploy --provider.cluster devnet --provider.wallet .runtime/devnet-payer.json`.
3. For the transaction helper, install `@solana/web3.js@1.99.0` with `npm install --no-save --package-lock=false @solana/web3.js@1.99.0` or point `STACK_WEB3_ENTRY` at an existing compatible entry. `node scripts/devnet-request.mjs --prepare` derives public addresses without signing or contacting the network. Set `STACK_DEVNET_KEYPAIR` to the dedicated test payer path and run `node scripts/devnet-request.mjs --send-devnet` to request the seed. It writes `.runtime/devnet-proof.json` after the callback finalizes. To retrieve a pending or completed earlier request, run `node scripts/devnet-request.mjs --recover-devnet YYYY-MM-DD` for its UTC date.
4. Run `node scripts/proof.mjs .runtime/devnet-proof.json` to verify the proof. On the judge-facing host, set `HOST=0.0.0.0`, point `STACK_DATA_DIR` at persistent storage, and set `STACK_REQUIRE_VERIFIED=1`. Set `STACK_PROOF_JSON` to the public receipt JSON or `STACK_PROOF_FILE` to its path. Use one server instance for the leaderboard and the host's `PORT` value for the listen port. `GET /health` reports `devnet-verified` when the verified contest game is ready. The proof pins one challenge for review.
5. Play from two fresh sessions, follow the same shared challenge link, verify the live leaderboard and Explorer transaction, then record the submission demo.

Keep the devnet test payer and program key out of GitHub, screenshots, and the website. The existing World game and paid prizes are independent of this demo. Guest names and scores are for the demo leaderboard.

GitHub's **Paper Stack checks** workflow runs the game tests on pushes to `main`. Run it manually to compile on an Ubuntu runner with the pinned tools. Select **Deploy on devnet and request the VRF draw** for the contest proof. Open the running deployment step to see the new test payer's address and the amount of test SOL required. Fund that address through a [supported devnet faucet](https://solana.com/developers/cookbook/development/airdrops-and-faucets) while the run is active. The payer, program, and upload buffer keys stay on the temporary runner. The completed run exports only the public `devnet-proof.json` receipt and links to the finalized callback in its summary.

## Entry and assets

- [Register on Luma](https://luma.com/hedv5sgh) and use [MagicBlock Build](https://build.magicblock.app/?event=17&stage=blitz#submit) for the entry. The deadline is Friday, November 27 at 8:00 a.m. Chicago time.
- The form uses Telegram sign-in and requests a project description, site URL, accessible GitHub repo, pitch/demo URL, Explorer proof link and a Solana prize wallet. See [the pitch and recording plan](SUBMISSION.md).
- The original stack rules and `public/assets/stack.jpg` come from the November 24 Printer World Paper Stack release. The printed job sequence, shareable and replayable scorecards, guest leaderboard, seed program and proof verification are Blitz demo work. The original challenge IDs continue to load their own classic board during the corresponding day.
- `public/assets/magicblock.png` is a transparent raster export of [MagicBlock's official white logo](https://www.magicblock.xyz/assets/magicblock-logo.svg). The lockup identifies the page as a Blitz entry.
