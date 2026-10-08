# Kotoba

Kotoba is a local-first Chrome extension for learning Japanese vocabulary as you browse. It segments Japanese text, marks unfamiliar words, adds furigana, and remembers words you have encountered.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Refresh any pages that were already open.

## Features

- **Japanese word analysis:** Kuromoji and its IPA dictionary run locally in the browser. Adjacent analyzer tokens are merged when they form a word in Kotoba's bundled vocabulary.
- **New-word cues:** New words are highlighted. Furigana is shown for kanji words when the analyzer supplies a reading. Cues remain on the current page after recording, and later page visits omit default furigana for words already seen.
- **Encounter history:** A word is recorded when it enters the visible viewport. Scrolling on the same page does not increase its encounter count; another page visit does. Kotoba stores first-seen and last-seen dates.
- **Word details:** Click a word to see its meaning and encounter history. Holding the pointer over it for three seconds opens the same panel and turns on furigana when available.
- **Vocabulary list:** Open the extension popup and choose **Vocabulary** to search your history, view encounter dates, export it as JSON, or clear it.

## Privacy and permissions

Kotoba needs access to page text so it can find Japanese words. Word analysis and furigana generation run locally using the files in `vendor/`. Encounter history and cached lookups are stored in Chrome's local extension storage and are not synced by Kotoba.

When a clicked word has no English meaning in the bundled starter vocabulary, Kotoba sends that word to Jisho to request a definition. It does not send the page URL or surrounding page text. See the [Jisho API](https://jisho.org/api/v1/search/words?keyword=猫).

The extension requests Chrome's `storage` permission, access to pages where its content script runs (`<all_urls>`), and host access to `jisho.org` for those definition lookups.

## Known limitations

Kuromoji provides broad Japanese coverage, but readings may be missing or incorrect for names, rare terms, and context-dependent words. Japanese word boundaries can also be ambiguous. The bundled English vocabulary is small; uncatalogued meanings require a click-time Jisho lookup.

## License

Kotoba's original code is licensed under the MIT License; see [LICENSE](LICENSE). The bundled Kuromoji analyzer and IPA dictionary retain their separate Apache 2.0 and dictionary notices in [`vendor/`](vendor/).
