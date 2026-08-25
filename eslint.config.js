import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.local/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The wire is `unknown` until a caller asserts a shape onto it, and several public
      // signatures are generic over that shape. Template expressions and member access on
      // decoded JSON are the normal case here, not a smell.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Long, deliberate error messages are this package's whole point; they are built by
      // concatenation and read better without a rule fighting them.
      // `??` is the safer operator for most types, but not for the strings in this package: an
      // empty `instance`, `name` or `servers` means UNSET, and `??` would keep the empty string
      // and produce a subject nobody is subscribed to.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignoreConditionalTests: true, ignorePrimitives: { string: true } },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
      // Bracket access on an index signature is not a style choice under
      // noUncheckedIndexedAccess — it is what expresses "this key may not be there". Dot
      // notation on a Record would claim a property the type never promised.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // `value as string` over `value!`: the assertion says WHAT is being claimed, and a
      // refactor that changes the type breaks it loudly instead of compiling on in silence.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
    },
  },
  {
    // The browser example is plain JavaScript, because that is what someone pasting it into a
    // bundler will have. tsconfig includes it (allowJs, checkJs off) so the type-aware rules
    // have a program to work with; the DOM globals it uses are declared here.
    files: ['examples/browser/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        sessionStorage: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Examples are written to be read: an unused binding in a `for await` is the point being
    // made, not an oversight.
    files: ['examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests assert on shapes the compiler cannot know and deliberately pass bad input.
    files: ['test/**/*.ts'],
    rules: {
      // node:test's describe()/test() return promises nobody is meant to await; awaiting them
      // is what actually breaks the runner.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
