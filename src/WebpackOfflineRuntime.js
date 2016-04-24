'use strict';

const MemoryFileSystem = require("memory-fs");
const webpack = require('webpack');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const Promise = require('bluebird');
const _ = require('lodash');
const requireFromString = require('require-from-string');


/**
 * Default options
 *
 * @type {{useMemoryFs: boolean, config: Object, configPath: string}}
 */
const defaultOptions = {
	useMemoryFs: true,
	configPath: 'webpack.config.js',
	config: null
};

let options = null,
	resolver = null,
	log = null,
	config = null,
	memoryFileSystem = null,
	outputPath = null,
	S = null,
	project = null,
	compiler = null,
	compilationCallbacks = [];

// the state, false: bundle invalid, true: bundle valid
let state = false;

// in lazy mode, rebuild automatically
let forceRebuild = false;


function getOutputFileSystem() {
	if (options.useMemoryFs) {
		if (!memoryFileSystem) {
			memoryFileSystem = new MemoryFileSystem();
		}

		return memoryFileSystem;
	} else
		return require('fs');
}

// wait for bundle valid
function resolveWhenReady(fn) {
	if(state)
		return fn();

	// if(!options.noInfo && !options.quiet)
	log("webpack: wait until bundle finished: " + (fn.name));

	compilationCallbacks.push(fn);
}


/**
 * Make webpack compilation callback
 *
 * @param watching
 * @returns {compileComplete}
 */
function makeWebpackCallback(watching) {
	return function compileComplete(err,stats) {
		if (err) {
			log(`webpack: (watching=${watching}) Compilation failed: ${stats.toString(config.stats)}`, err);
		} else {
			log(`webpack: (watching=${watching}) Compilation succeeded`);
		}
	}
}

/**
 * Create a the configuration object
 */
function makeConfig() {
	if (config)
		throw new Exception('Config can only be created once');

	options = project.custom.webpack || {}
	_.defaultsDeep(options,defaultOptions);

	if (options.config) {
		config = options.config;
	} else {
		let configPath = path.resolve(options.configPath);
		if (!fs.existsSync(configPath)) {
			throw new Error(`Unable to location webpack config path ${configPath}`);
		}

		log(`Making compiler with config path ${configPath}`);
		config = require(configPath);
	}


	config.target = 'node';

	// Output config
	outputPath = path.resolve(process.cwd(),'target');
	if (!fs.existsSync(outputPath))
		mkdirp.sync(outputPath);

	const output = config.output = config.output || {};
	output.library = '[name]';
	output.libraryTarget = 'commonjs';
	output.filename = '[name].js';
	output.path = outputPath;

	log('Building entry list');
	const entries = config.entry =  {};

	const functions = project.getAllFunctions();
	functions.forEach(fun => {

		// Runtime checks
		// No python or Java :'(

		if (fun.runtime !== 'webpack') {
			log(`${fun.name} is not a webpack function`);
			return
		}


		const handlerParts = fun.handler.split('/').pop().split('.');
		const handlerPath = require.resolve(fun.getRootPath(handlerParts[0]));

		log(`Adding entry ${fun.name} with path ${handlerPath}`);
		entries[fun.name] = handlerPath;
	});

	log(`Final entry list ${Object.keys(config.entry).join(', ')}`);
}

function invalidPlugin() {
	if(state)
		log("webpack: bundle is now INVALID.");
	// We are now in invalid state
	state = false;
}
function invalidAsyncPlugin(_compiler, callback) {
	invalidPlugin();
	callback();
}


/**
 * Create the webpack compiler
 */
function makeCompiler() {
	if (!config) {
		makeConfig();
	}

	compiler = webpack(config);
	if (options.useMemoryFs)
		memoryFileSystem = compiler.outputFileSystem = new MemoryFileSystem();

	log('webpack: First compilation');
	compiler.run(makeWebpackCallback(false));
	log('webpack: Watching');
	compiler.watch({},makeWebpackCallback(true));


	compiler.plugin("invalid", invalidPlugin);
	compiler.plugin("watch-run", invalidAsyncPlugin);
	compiler.plugin("run", invalidAsyncPlugin);





	compiler.plugin("done", stats => {
		// We are now on valid state
		state = true;


		function continueBecauseBundleAvailable(cb) {
			cb();
		}

		function readyCallback() {
			// check if still in valid state
			if(!state) return;

			log(`webpack compiled ${stats.toString(config.stats || {})}`)

			// print webpack output
			// var displayStats = (!options.quiet && options.stats !== false);
			// if(displayStats &&
			// 	!(stats.hasErrors() || stats.hasWarnings()) &&
			// 	options.noInfo)
			// 	displayStats = false;
			// if(displayStats) {
			// 	console.log(stats.toString(options.stats));
			// }
			// if (!options.noInfo && !options.quiet)
			console.info("webpack: bundle is now VALID.");

			// execute callback that are delayed
			var cbs = compilationCallbacks;
			compilationCallbacks = [];
			cbs.forEach(continueBecauseBundleAvailable);
		}

		// Do the stuff in nextTick, because bundle may be invalidated
		//  if a change happened while compiling
		process.nextTick(readyCallback);

		// In lazy mode, we may issue another rebuild
		if(forceRebuild) {
			forceRebuild = false;
			rebuild();
		}
	});
}

function rebuild() {
	if(state) {
		state = false;
		compiler.run(err => {
			if(err) throw err;
		});
	} else {
		forceRebuild = true;
	}
}

function makeResolver() {
	log('Making resolver');

	resolver = {
		resolveWhenReady,
		resolve(funName) {
			return new Promise((resolve,reject) => {
				const outputFile = path.resolve(outputPath,`${funName}.js`);
				const srcFile = config.entry[funName];
				log(`webpack: resolving ${funName} with ${outputFile}`);

				function doResolve() {
					if (!state) {
						return reject(new Error('resolve called on state not ready'));
					}

					log(`webpack: resolving now - ready! - ${outputFile}`);


					getOutputFileSystem().readFile(outputFile, (err,data) => {
						if (err) {
							console.error(`Failed to load output content for ${outputFile}`,err.stack);
							return reject(err);
						}

						const loadedModule = requireFromString(data.toString(),srcFile);
						// const loadedModule = requireFromString(data.toString(),outputFile);
						return resolve(loadedModule);
					});
				}

				try {
					resolveWhenReady(doResolve);
				} catch (err) {
					console.error('webpack failed to resolve' + funName,err.stack);
					reject(err)
				}
			});
		}
	};

	return resolver;
}


module.exports = (_S, _project) => {
	S = _S;
	project = _project;
	log = S.config && S.config.serverlessPath ?
		require(path.join(S.config.serverlessPath, 'utils', 'cli')).log :
		console.log.bind(null, 'Serverless:');



	makeCompiler();

	return makeResolver();
}


