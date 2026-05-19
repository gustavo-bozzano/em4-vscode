# EM4 Script LSP (VSCode)

VSCode extension for Emergency 4 / Los Angeles Mod `.script` files.

## Features

- `em4script` language recognition for `.script` files
- Improved syntax highlighting
- LSP support with:
  - Global autocomplete (keywords, local symbols, and SDK symbols)
  - **Type-aware contextual autocomplete** for `->`, `.` and `::` (e.g., `Vehicle` vs `Person` methods)
  - **Go to Definition** for local symbols, SDK symbols, and contextual members
  - **Hover with signature + documentation** extracted from `//` comments in SDK/source code
  - **Basic diagnostics**:
    - unbalanced delimiters (`()`, `[]`, `{}`)
    - undeclared base identifier in member access
    - missing member for inferred type/namespace
  - Document symbols

## How to test locally

1. Open the `vscode-em4-lsp` folder in a terminal.
2. Install dependencies:
   - `npm install`
3. Validate JavaScript files:
   - `npm test`
4. In VSCode, open the repository root and press `F5` from the extension folder to launch the *Extension Development Host*.

## Notes

- If a workspace-level `EM4 sdk` folder exists, it is also loaded.
- SDK hover/completion documentation is read from contiguous `//` comments or block comments (`/* ... */`) placed directly above declarations.
- Keep SDK comments in English and close to the related symbol (`enum`, `class`, method, function, constant) so the LSP can attach the text reliably.
- 
## License

This project is licensed under the GNU GPL v3.