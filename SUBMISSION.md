# Paper Stack Daily Challenge | Solana Blitz v10

Submissions close Friday, November 27 at 8:00 a.m. Chicago time. MagicBlock judges creativity, technical depth, and what the project demonstrates on Solana. Eligibility requires a MagicBlock Ephemeral Rollup or VRF integration. [Organizer's announcement](https://x.com/magicblock/status/2125953035470041411) · [Blitz rules](https://build.magicblock.app/?stage=blitz) · [Entry form](https://build.magicblock.app/?event=17&stage=blitz#submit)

## Entry copy for the verified build

**Project name** Paper Stack Daily Challenge

**Categories** Games, Social

Your friend stacked four sheets. Can you fill all three print orders?

Paper Stack started as an arcade game in Printer World. For Blitz, we built a daily rematch around one MagicBlock VRF draw. It decides which job comes first, how fast Rush sheets slide, how tight a Fine Cut has to be, and how long Quick Dry gives you. Everyone gets the same orders. Play as a guest, stack as many sheets as you can, and send a friend the score to beat.

Click **Verified draw** at the top of the game to find the Solana transaction. Open a saved scorecard to replay its recorded timings against that exact draw and check the score in your browser.

We reused the original stacking rules and kiosk artwork from Printer World. The print orders, guest leaderboard, shareable scorecards, run replay check, and Solana devnet RNG integration were built for Blitz. [Printer World](https://printer.world/)

## Evidence to attach

| Field | What judges open |
| --- | --- |
| Project website | The game loaded with a verified draw and a working leaderboard. |
| GitHub project repo | Accessible contest source with the seed program, verifier, tests, and setup. |
| Pitch and demo | A short recording of someone playing the same draw from a shared scorecard. |
| Explorer link | The finalized Solana devnet callback that supplied this exact draw. |
| On-chain address | The deployed daily seed program ID. |

Open all four links in a private browser window before submitting. The project website should show the verified draw on the first screen. Start from its shared scorecard URL so the judge has a score to beat and a run to check. The organizer uses Telegram sign-in and a Solana prize wallet. SNEK chooses and connects that wallet.

## Screen recording

| Beat | What to show |
| --- | --- |
| The draw | Start with the three printed orders and their actual speed, tolerance, and deadline. |
| The first run | Stack four sheets on desktop, save the score, and copy the scorecard link. |
| The rematch | Open the link on a phone. Play the same orders, save a higher score, and show both runs on the same board. |
| The receipts | Open the run check and the Solana transaction. Show the draw that governs the game and the saved timing that reproduces the score. |

## Build status

The local build displays the seeded job sequence and the individual rule settings. It records the timings of accepted drops and can check a saved score from its share link. The locally tested proof interface uses test data. The public demo, accessible repository, real callback, recording with that callback, and submission are pending.

[Devnet build steps](README.md#devnet-proof) · [MagicBlock VRF quickstart](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart)
