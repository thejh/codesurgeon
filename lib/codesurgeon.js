
var fs = require('fs'),
    colors = require('colors'),
    eyes = require('eyes'),
    path = require('path'),
    traverse = require('traverse'),
    jslint = require('jslint-core'),
    jshint = require('jshint'),
    vm = require('vm'),
    uglify = require('uglify-js'),
    astjourney = require('astjourney');

//
// Codesurgeon
//
var Codesurgeon = exports.Codesurgeon = function (options) {
  if (!(this instanceof Codesurgeon)) return new Codesurgeon(options);

  options = options || {};

  this.options = {
    encoding: options.encoding || 'utf8',
    quiet: options.quiet || false,
    seperator: options.seperator || '\n\n'
  };

  this.inputs = {};
  this.output = '';
};

//
// ### function clear
// Provides the opportunity to clear the input and output buffers
// before the next read and write.
//
Codesurgeon.prototype.clear = function(option) {
  if (option === 'inputs') {
    this.inputs = {};
  }
  else if (option === 'output') {
    this.output = '';
  }
  else {
    this.inputs = {};
    this.output = '';    
  }
  return this;
};

//
// ### function configure (options)
// #### @options {Object} **Optional** Options to configure this instance with
// Configures this instance with the specified `options`.
//
Codesurgeon.prototype.configure = function (options) {
  var that = this;
  Object.keys(options).forEach(function(key) {
    if(key === 'package') {
      return that.package(options[key]);
    }
    that.options[key] = options[key];
  });
  return this;
};

// ### function package (file)
// ##### @file {String} A string representing the path to a package.json file.
// Read in the package.json file for making the output filename and headers nice.
//
Codesurgeon.prototype.package = function(file) {
  this.packageJSON = JSON.parse(fs.readFileSync(file, 'utf8'));
  return this;
};

// ### function read (...files)
// ##### @files {...String} One or more strings representing files to be read.
// Read one or more files async or sync from which to create output.
//
Codesurgeon.prototype.read = function (files) {
  var file, callback;
  var that = this;
  var i = 0, l = arguments.length;
  var count = l-1;

  if(typeof arguments[arguments.length-1] === 'function') {
    callback = arguments[arguments.length-1];
    l--;
  }

  for (i = 0; i < l; i++) {
    file = arguments[i];
    !this.options.quiet && console.log('Read file [' + file.yellow + ']');

    if(callback) {
      fs.readFile(file, this.options.encoding, (function(file) {
        return function(err, data) {
          if(err) {
            !that.options.quiet && console.log(err + ' [' + file.red + ']');
          }

          that.inputs[file] = data + that.options.seperator;
          --count;
          if(count === 0) {
            callback.call(that);
            return that;
          }
        };
      }(file)));
    }
    else {
      this.inputs[file] = fs.readFileSync(file, 'utf8');
    }
  }
  this.lastread = file;
  return this;
};

// ### function wrap (options)
// #### @options {Object} **Optional** Options to wrap the current code with
// ##### @params {String} Allow the user to determine what the closure will
// Wraps the extracted source with a closure.
//
Codesurgeon.prototype.wrap = function (options) {
  options = options || {};

  var signature = options.signature || 'exports';
  var params = options.params || 'window';
  var outside = options.outside || '';
  var before = options.before || '';
  var after = options.after || '';
  var type = options.type || 'expression';
  var identifier = options.identifier || 'i' + String(Date.now());
  var instance = options.instance ? 'new' : '';

  if(type === 'expression') {
    this.output = [
      outside,
      '(function (' + signature + ') {',
      before,
      this.output,
      after,
      '}(' + params + '));'
    ].join('\n');
  }

  if(type === 'declaration') {
    this.output = [
      'var ' + identifier + ' = ' + instance + ' function (' + signature + ') {',
      before,
      this.output,
      after,
      '};'
    ].join('\n')
  }

  return this;
};

//
// ### function extract(identifiers)
// #### identifiers {...String} one of more string literals denoting identifiers.
// Does analysis to find the required members, methods, functions 
// or variables and then writes a new file with the exhumed etc.
//
Codesurgeon.prototype.extract = function (identifiers) {

  var inputs = this.inputs;
  var that = this;

  var blob = '';
  var l = arguments.length || 1;
  var args = new Array(l - 1);
  var output = new Array(l - 1);

  for (var i = 0; i < l; i++) args[i] = arguments[i];

  Object.keys(inputs).forEach(function (script) {
    blob += inputs[script];
  });
  
  if(!identifiers) {
    this.output = blob;
    return this;
  }

  var ast = astjourney.makeAst(blob);
  astjourney.updateParentData(ast);
  astjourney.addScopeData(ast);

  var opts = { indent_level: 4, beautify: true };

  //
  // Note: traverse will walk the AST and discover the entities
  // if there are any that match the high level entities that we
  // are interested in, we'll capture them and copy them into our
  // output buffer.
  //
  

  astjourney.visitAll(ast, function(node, parents) {
    switch(node.type) {
      case 'var':
        //
        // traverse upward again to determine allowed depth.
        // currently only supporting a depth of `toplevel`.
        //
        var level = node.parent.type;
        // this only looks at one of the variables declared here...
        var name = node.vardefs[0].name;
        var arg;

        if (level === 'toplevel') {
          for (i = 0, sl = args.length; i < sl; i++) {
            //
            // TODO 
            // -- warn if multiple found.
            // -- add level check inside this loop.
            //
            arg = args[i];
            
            if (Array.isArray(args[i])) {
              arg = args[i][0];

              for(var j = 0, jl = args[i].length; j < jl; j++) {
                if(typeof args[i][1] === 'string') {
                  node.vardefs[0].name = args[i][1];
                }
              }
            }
            
            if (name === arg) {
              output[i] = uglify.uglify.gen_code(this.parent.node, opts);
            }
          }
        }
      break;
      case 'stat':
        var level = node.parent.type;
        if (level === 'toplevel') {
          var segment = node.stat;

          // exports.A = B => go deeper in assignment
          if (segment.type === 'assign' && segment.op === true) {
            segment = segment.lvalue;
          }

          // Traverse segment tree and extract all names
          function getName(segment) {
            if (segment.type === 'dot') {
              return getName(segment.expr).concat(segment.property);
            } else if (segment.type === 'name') {
              return [segment.value];
            } else {
              return ['!'];
            }
          };

          var chunks = getName(segment),
              name = chunks.join('.'),
              arg,
              newname;

          for (i = 0, sl = args.length; i < sl; i++) {
            //
            // TODO warn if multiple found.
            //
            arg = args[i];

            if (Array.isArray(args[i])) {
              arg = args[i][0];

              for(var j = 0, jl = args[i].length; j < jl; j++) {
                if(typeof args[i][1] === 'string') {
                  newname = args[i][1].split('.');
                  // FIXME I don't understand what this line does - what's the node type?
                  segment[segment.length-1] = newname[newname.length-1];
                }
              }
            }

            if (name === arg) {
              // if (chunks.length > 2) {
              //   chunks.slice(1).reduce(function (acc, name) {
              //     return acc + '.' + name;
              //   });
              // }
              output[i] = astjourney.stringifyAst(node, opts);
            }
          }

        }
      break;
      case 'defun':
        var level = node.parent.type;
        if (level === 'toplevel') {
          var arg;

          for (i = 0, sl = args.length; i < sl; i++) {
            // 
            // TODO warn if multiple found.
            // 
            arg = args[i];
            
            if (Array.isArray(args[i])) {
              arg = args[i][0];

              for(var j = 0, jl = args[i].length; j < jl; j++) {
                if(typeof args[i][1] === 'string') {
                  node.name = args[i][1];
                }
              }
            }
            
            if (node.name === arg) {
              output[i] = astjourney.stringifyAst(node, opts);
            }
          }
        }
      break;
      case 'block':
        // not yet used.
      break;
    }
  });
  
  this.output += output.join(that.options.seperator) + that.options.seperator;
  return this;
};

//
// ### function write (files)
// Attempts to write to the file with the output buffer.
//
Codesurgeon.prototype.write = function (file, callback, flags) {
  var that = this;
  !this.options.quiet && console.log('Write file [' + file.green + ']');

  if(this.packageJSON) {
    if(file.substr(-3) === '.js') {
      //
      // assume that the part of the name before the first dot is the name
      // capture that and preserve the rest to append after we add the version.
      //
      var realName = file.replace(/(\.\.\/)/g, '   ');
      realName = realName.replace(/(\.\/)/g, '  ');

      var name = file.substr(0, realName.indexOf('.'));
      var extras = file.substr(realName.indexOf('.'), realName.length);
      file = name + '-' + this.packageJSON.version + extras;
    }
    
    var owner = this.options.owner || this.packageJSON.author || 'Codesurgeon.';

    this.output = [ // make a nice header for the new file.
      '//',
      '// Generated on ' + (new Date()) + ' by ' + owner,
      '// Version ' + this.packageJSON.version,
      '//\n'
    ].join('\n') + this.output;
  }

  //
  // if there is a callback, this must be a asyncronous call, 
  // so open, write and close the file and alter the user of errors.
  //
  if(callback) {
    fs.open(file, flags || 'w', function(err, fd) {
      if(err) {
        !that.options.quiet && console.log(err + ' [' + file.red + ']');
      }
      fs.write(fd, '\n\n' + that.output, null, 'utf8', function(err) {
        if(err) {
          !that.options.quiet && console.log(err + ' [' + file.red + ']');
        }
        fs.close(fd, function(err){
          if(err) {
            !that.options.quiet && console.log(err + ' [' + file.red + ']');
          }
          else {
            !that.options.quiet && console.log('Write file [' + file.green + ']');
          }
          
          callback.call(that);
          return that;
        });
      });
    });
  }
  else {
    var fd = fs.openSync(file, flags || 'w');
    var data = fs.writeSync(fd, '\n\n' + this.output);
    fs.closeSync(fd);
  }
  this.newfile = file;
  return this;
};

//
// ### function append (files)
// Attempts to append code to an existing file
//
Codesurgeon.prototype.append = function (file, callback) {
  this.write(file, callback, 'a');
  return this;
};

//
// ### function uglify (options)
// #### @options {Object} configuration options for unglification.
// Attempts to uglify the output and make it available prior to write..
//
Codesurgeon.prototype.uglify = function (options) {
  !this.options.quiet && console.log('Uglify code.');
  
  options = options || {};
  
  var mangle = !!options.mangle === false || options.mangle;
  var squeeze = !!options.squeeze === false || options.squeeze;
  
  var ast = uglify.parser.parse(this.output);

  if(mangle) {
    ast = uglify.uglify.ast_mangle(ast);
  }
  
  if(squeeze) {
    ast = uglify.uglify.ast_squeeze(ast);
  }
  
  this.output = uglify.uglify.gen_code(ast);
  return this;
};

//
// ### function addreqs(options)
// #### @options {Object} an object literal of configuration options.
// try to run the code, hijack the require function and try to aquire 
// the complete code necessary to run the program.
//
Codesurgeon.prototype.validate = function(options, output) {

  var that = this;
  var requirements = [];

  var sandbox = {
    //
    // hijack the require function.
    //
    require: function(s) {

      //
      // if we find a path to a local file, try to read the file,
      // add its contents to the output buffer and the recurse into
      // addreqs again in case there are new requirements inside the
      // expanded buffer.
      //
      if(s[0] === '.' || ~s.indexOf('/')) {

        !that.options.quiet && console.log('A module was required, but not inlined to the buffer [' + s.red + ']');

        //
        // inlining the code presents two problems, 1. the filename which i think we can deduce from
        // the last read file (provided as `that.lastfile`). 2. the module has several ways to export
        // so it may be `this`, `module.exports`, `exports`, etc. Here's one potential solution...
        //


        // var lastpath = that.lastread.substr(0, that.lastread.lastIndexOf('/')+1);

        //
        // this obviously does not work, could possibly stat for the file in the same order that
        // node tries to search for it.
        //
        // var fileandpath = lastpath + s + '.js';
        // that.read(fileandpath);

        // var requirement = new RegExp('\\(?require\\)?\\s*\\([\\\'|"]' + s + '[\\\'|"]\\)');
        // var wrappedcode = '(function(module) { \n\n' + that.inputs[fileandpath] + '\n\n return module; })()';

        // that.output = that.output.replace(requirement, wrappedcode);

      }
      //
      // this is a requirement for a module not a file, we can add it
      // to the requirements path.
      //
      else {
        requirements.push(s);
        require(s);
      }
    }
  };

  //
  // attempt to run the code in a new context, its ok
  // for errors to occur, we'll just report them to the
  // user. We hijack the require function and push the
  // module name to an array that we can use to build
  // up our unknown dependencies list.
  //
  try {
    vm.runInNewContext(output || this.output, sandbox, 'tmp.vm');
  }
  catch(ex) {
    !that.options.quiet && console.log('An error occured while executing the code in the ouput buffer [', ex.message.red, ']');
  }

  //
  // remove any known requirements and add any new 
  // requirements that are found in the output code.
  //
  requirements.forEach(function(dep, i) {
    if(that.packageJSON.dependencies[dep]) {
      requirements.splice(i, 1);
    }
    else {
      that.packageJSON.dependencies[dep] = '*';
    }
    
  });

  //
  // tell the user we found some unique requirements from
  // out analysis of the output buffer.
  //
  !that.options.quiet && console.log('Able to add the following modules to the package.json [', requirements.join(', ').green, ']');

  //
  // we now have an updated dependencies member in the package.json 
  // structure, we could possibly rewrite the file depending on the
  // options that the user has chosen.
  //
  // console.log(this.packageJSON.dependencies)

  return this;
};

//
// ### function hint(success, [, fail, options])
// #### @success {Function} a callback that will be executed when the validator yields success.
// #### @fail {Function} a callback that will be executed when the validator yields failure.
// #### @options {Object} an object literal containing the options that are supported by the parser.
// a less strict javascript validator.
//
Codesurgeon.prototype.hint = function(success, fail, options) {

  if(typeof fail !== 'function') {
    option = fail;
  }

  var valid = jshint.JSHINT(this.output, options);

  if(valid === false && !this.options.quiet) {
    console.log('Hint fail!');
    eyes.inspect(jshint.JSHINT.errors);
    fail && fail.call(this);
  }
  else {
    success && success.call(this);
  }
  return this;
};

//
// ### function lint(success [, fail, options])
// #### @success {Function} a callback that will be executed when the validator yields success.
// #### @fail {Function} a callback that will be executed when the validator yields failure.
// #### @options {Object} an object literal containing the options that are supported by the parser.
// a very strict javascript validator.
//
Codesurgeon.prototype.lint = function(success, fail, options) {

  if(typeof fail !== 'function') {
    option = fail;
  }

  var valid = jslint.JSLINT(this.output, options);

  if(valid === false && !this.options.quiet) {
    console.log('Lint fail!');
    eyes.inspect(jslint.JSLINT.errors);
    fail && fail.call(this);
  }
  else {
    success && success.call(this);
  }
  return this;
};
