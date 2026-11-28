import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	ignores: ['build/dist/', 'iframe/', 'test/.out/', 'test/fixtures/', 'src/panel/demo.json', 'src/panel/demo-finish.json', 'coverage/', 'dist/', 'node_modules/', '.eslintcache', 'debug.log'],

	rules: {
		'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
		'regexp/no-unused-capturing-group': 'off',
		'no-labels': 'off',
		'no-sequences': 'off',
		'ts/no-unused-expressions': 'off',
		'ts/no-use-before-define': 'off',
		'no-unreachable-loop': 'off',
		'style/max-statements-per-line': 'off',
		'test/no-import-node-test': 'off',
		'antfu/no-top-level-await': 'off',
	},
});
