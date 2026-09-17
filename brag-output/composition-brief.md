# Hyperframes Composition Brief: USOS++

## Objective
Create a short launch-style brag video for USOS++.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: /Users/mwyszk/Developer/USOS++
- Primary files read: manifest.json, core/ui/design-system.css, README.md, design/USOS++.dc.html
- Product name: USOS++
- Tagline / strongest claim: "University, upgraded."
- Key UI or visual moment to recreate: The dark-mode dashboard with orange accent stats cards.
- Copy that must appear verbatim:
  - "University portals were built for records."
  - "Not for students."
  - "University, upgraded."

## Creative Direction
- Tone preset: yc-parody
- Creative direction: Fake Series A launch for student infrastructure.
- Interpretation: Serious, matter-of-fact delivery. No winking. The absurdity comes from the contrast between the "enterprise" tone and the fact that it's a university portal.
- Angle: The "Academic OS" upgrade. We treat the transition from a 2005-era web portal to a modern dashboard as a major infrastructure milestone.
- Hook: "University portals were built for records. Not for students."
- Outro / punchline: "University, upgraded."
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign

## Visual Identity
- Background: oklch(18% 0.01 55)
- Text: oklch(94% 0.004 55)
- Accent: #d9773a
- Display font: General Sans
- Body font: General Sans
- Visual references from the project: The dark-mode dashboard design system (oklch colors, General Sans font, #d9773a accent).

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. The Hook — 3s — Text "University portals were built for records." then "Not for students."
2. The Reveal — 5s — Legacy USOS $\rightarrow$ Toggle $\rightarrow$ Modern Dashboard.
3. The Metrics — 5s — Sequential pop-in of GPA, ECTS, and Next Class cards.
4. The Plan — 4s — Cinematic pan over the Weekly Schedule.
5. The Outro — 3s — Logo slam and "University, upgraded." tagline.

## Audio
- Audio role: warm bed
- Audio arc: Starts with a steady corporate bed, builds tension during the hook, and resolves with a satisfying impact on the logo slam.
- Music: happy-beats-business-moves-vol-11-by-ende-dot-app.mp3
- Music treatment: Steady volume (0.35). Subtle swell during the "Reveal" transition.
- Music cue guidance: bundled preset `assets/music/cues/happy-beats-business-moves-vol-11-by-ende-dot-app.music-cues.json`. Strong cues at 1.60s (Hook), 3.70s (Reveal), and 17.91s (Outro).
- Audio-reactive treatment: subtle; use music RMS to make the dashboard cards "breathe" slightly.
- Audio-coupled moments:
  - Scene 2 Reveal — simulated toggle click $\rightarrow$ `interface/click_001`
  - Scene 3 Metrics — card sequence $\rightarrow$ `interface/drop_002` sequence
  - Scene 5 Outro — logo slam $\rightarrow$ `impact/impactBell_heavy_000`
- SFX selection guidance: Use clean, professional UI sounds. Match card arrivals to the beat grid.
- SFX analysis guidance: Use `skills/brag/assets/sfx/sfx-analysis.md` to ensure low HF risk for repeated card sounds.
- Exact SFX choice: Hyperframes should choose filenames, timestamps, density, and volume based on the implemented animation.
- Audio files: copy the chosen music and any Hyperframes-selected SFX into `brag-output/composition/assets/`

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). /brag is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo / launch-video workflow. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:
- Show at least one real UI, copy, or visual element from the source project.
- Keep all text readable in the final render.
- Keep the video within 15-25 seconds.
- Include the planned music/SFX layer unless audio was explicitly disabled or documented as intentionally silent.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints. Hyperframes decides exact animation timing and should ignore cues that hurt readability, scene pacing, or the product story.
- Major reveals may move toward nearby strong cues within about 0.15s. Smaller entrances may align to nearby beat points within about 0.10s. Use only 1-3 strong cue locks in a 15-25s video unless the edit clearly benefits from more.
- Use SFX to support motion and interaction: card sounds for card-like reveals, short announcement cues for major payoffs, key/click sounds for text or user actions, and restraint when the edit is already busy.
- Honor planned music treatment such as fade-outs, ducking, beat-aligned reveals, or letting a final SFX ring over the music, using the best Hyperframes-supported implementation.
- When music is present and the treatment is not `none`, consider Hyperframes audio-reactive workflow: extract audio data and use RMS/frequency bands for subtle, brand-specific motion. Good targets are glow, depth, background warmth, card presence, title emphasis, or other existing visual elements. Avoid waveform/equalizer visuals, musical-note graphics, generic particle systems, strobing, or heavy pulsing.
- Use local assets for audio and any required runtime/media dependencies when possible.
- Run `hyperframes check` before render — it is brag's single gate.
