# X Comment Assistant · README motion treatment

20 seconds, silent, 1600×900, 60 fps master. A 25 fps / 1200×675 GIF is provided for README compatibility.

## Story

One authored source post → explicit Generate click → four Chinese drafts in different styles → choose and edit → send manually. The logo, composer View and style labels come from this project. Post/reply text is synthetic; handlers are inert, without network requests. The pacing is illustrative, not a model-latency benchmark.

## Motion

| Time | Action |
| --- | --- |
| 0–5 s | Fixed camera; pointer approaches Generate with smooth acceleration/deceleration |
| 5–6.1 s | One centred 1.00→1.05 push |
| 6.2–7.1 s | Camera holds while candidates expand and panel reframes |
| 9.1–11.6 s | Scroll to reveal the fourth candidate |
| 12.6–13.65 s | Select a draft, then pull back to the original scale |
| 13.75–14.65 s | Restore the editor and return the panel |
| 14.75–16 s | Collapse candidates smoothly, then edit the selected draft |
| 16.5–19.1 s | Read the edited draft; pointer stops beside Send |
| 19.1–20 s | Fade/reset content while preserving the brand and window shell |

Camera moves and panel moves are staggered. Pointer targets follow actual DOM bounds; the typing target uses a fixed first-line offset so text wrapping does not move the pointer. All presentation is derived from absolute time for consistent rendering and seeking.
