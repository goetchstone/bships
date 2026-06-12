import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', 'data/', 'reference/'] },
  ...tseslint.configs.recommended,
);
