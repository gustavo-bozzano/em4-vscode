# EM4 Script

Language support for **Emergency 4** and **911: First Responders** `.script` and `.lib` files in Visual Studio Code.

EM4 Script combines reliable syntax highlighting with a dedicated Language Server Protocol implementation, providing completion, navigation, documentation, diagnostics, formatting, and symbol tools for Emergency 4 mod development.

Project repository: [https://github.com/gustavo-bozzano/em4-vscode](https://github.com/gustavo-bozzano/em4-vscode)

## Features

### Syntax highlighting

- Automatic recognition of `.script` and `.lib` files as **EM4 Script**
- Highlighting for types, declarations, functions, members, constants, numbers, operators, comments, strings, and preprocessor directives
- Correct highlighting for multiple variables declared on the same line
- Recovery after incomplete strings, comments, and enum declarations, preventing the rest of the file from losing its colors

```cpp
bool mStartCutScene, mBusExtinguished, mExplosion, mTooManyVictims;
```

### Intelligent completion

- Suggestions for language keywords, local symbols, SDK symbols, and workspace libraries
- Type-aware member completion after `->`, `.`, and `::`
- Contextual suggestions for classes such as `Vehicle`, `Person`, and other SDK types
- Support for inherited SDK members

### Navigation and documentation

- **Go to Definition** for local declarations, SDK symbols, and contextual members
- Hover information with signatures and documentation
- Documentation extracted from comments placed directly above SDK or source declarations
- Document symbol navigation for classes, functions, variables, enums, and other declarations

### Diagnostics

The language server detects common editing mistakes, including:

- Unbalanced parentheses, brackets, and braces
- Unterminated strings and block comments
- Undeclared base identifiers in member access expressions
- Members that do not exist on an inferred type or namespace

Diagnostics are designed to provide fast feedback while editing. They do not replace validation by the Emergency 4 game engine.

### Editing tools

- Document formatting with spaces or tabs
- Preservation of the file's existing line endings
- Scope-aware rename for symbols declared in the current document
- Automatic refresh when `.script` or `.lib` files change

## Getting started

1. Install **EM4 Script** from the Visual Studio Code Marketplace.
2. Open your Emergency 4 mod or script folder in Visual Studio Code.
3. Open any file ending in `.script` or `.lib`.

The extension activates automatically. If a file is not detected, click the language indicator in the lower-right corner of Visual Studio Code and select **EM4 Script**.

## SDK support

The extension includes a bundled Emergency 4 SDK, so completion, hover information, definitions, and validation work immediately after installation.

You can add project-specific declarations by creating an `EM4 sdk` folder at the root of your workspace:

```text
my-em4-mod/
├── EM4 sdk/
│   ├── custom-types.script
│   └── custom-commands.script
└── Scripts/
    └── Command/
        └── MyCommand.script
```

All `.script` and `.lib` files inside `EM4 sdk` are loaded together with the bundled SDK. Changes to source files are detected without restarting Visual Studio Code.

## Library support

Workspace `.lib` files are indexed automatically and treated as EM4 Script source files. Global declarations in a library are exposed through the library filename, matching Emergency 4 usage. For example, functions declared in `lang.lib` are available through `Lang::`:

```cpp
Lang::PlayHint("BHint_0");
Lang::ShowMessageTickerTextForSinglePlayer(Caller, "BHint_1");
```

Library names are matched without case sensitivity, so `lang.lib` correctly provides the `Lang` namespace used by scripts.

To provide useful hover documentation, place `//` comments or block comments directly above a declaration:

```cpp
// Starts the custom vehicle command.
object StartVehicleCommand : CommandScript
{
    StartVehicleCommand();
};
```

## Development

Clone the repository and install the dependencies:

```bash
git clone https://github.com/gustavo-bozzano/em4-vscode.git
cd em4-vscode
npm ci
npm test
```

Open the repository in Visual Studio Code and press `F5` to launch an **Extension Development Host**.

## Feedback and contributions

Bug reports, feature requests, and contributions are welcome.

- [Source code](https://github.com/gustavo-bozzano/em4-vscode)
- [Report an issue](https://github.com/gustavo-bozzano/em4-vscode/issues)

When reporting a highlighting or language-server issue, include a small `.script` example that reproduces the problem.

## License

This project is distributed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).
