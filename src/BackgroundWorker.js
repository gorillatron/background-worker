"use strict";

var _                 = require( 'underscore' ),
    Promise           = require( 'bluebird' ),
    inherits          = require( 'util' ) .inherits,
    EventEmitter      = require( 'events' ).EventEmitter


var global = global || window

module.exports = BackgroundWorker

/*
 * @class BackgroundWorker
 * @extends EventEmitter
 * @author Jørn Andre Tangen @gorillatron
*/
function BackgroundWorker( spec ) {
  EventEmitter.apply( this, arguments )

  spec = spec ? spec : {}

  this.importScripts = spec.importScripts || []
  this.definitions = spec.definitions || []
  this.domain = spec.domain || (location.protocol + "//" + location.host)

  this._worker = null
  this._iframe = null
  this._messageId = 0
  this._messagehandlers = {}
  this._state = BackgroundWorker.CREATED
  this._isStarted = false
}

inherits( BackgroundWorker, EventEmitter )

/*
 * Check WebWorker support
 * @static
 * @returns {boolean}
*/
BackgroundWorker.hasWorkerSupport = function() {
  return (typeof window.Worker !== 'undefined' && typeof window.Blob !== 'undefined') && (typeof window.URL.createObjectURL == 'function')
}

BackgroundWorker.CREATED = {}

BackgroundWorker.RUNNING = {}

BackgroundWorker.IDLE = {}

BackgroundWorker.TERMINATED = {}

/*
 * Start the worker
 * @public
 * @function
*/
BackgroundWorker.prototype.start = function() {
  if( this._isStarted )
    throw new Error( 'cannot start allready started BackgroundWorker' )

  this._isStarted = true

  if( BackgroundWorker.hasWorkerSupport() ) {
    this.setupWebWorker()
  }
  else {
    this.setupIframe()
  }
  return this
}

/*
 * Setup a Worker
 * @public
 * @function
*/
BackgroundWorker.prototype.setupWebWorker = function() {
  this.blob = new Blob([
    this.getWorkerSourcecode()
  ], { type: "text/javascript" })

  this._worker = new Worker( window.URL.createObjectURL(this.blob) )

  this._worker.onmessage = _.bind( this.workerOnMessageHandler, this )
  this._worker.onerror = _.bind( this.workerOnErrorHandler, this )
}

/*
 * Setup a Iframe
 * @public
 * @function
*/
BackgroundWorker.prototype.setupIframe = function() {
  var script, src

  this._iframe = document.createElement( 'iframe' )

  script = document.createElement( 'script' )

  if( !this._iframe.style ) this._iframe.style = {}
  this._iframe.style.display = 'none';

  src = ""

  src += "var domain = '" + this.domain + "';\n"
  src += "var importScripts = " + JSON.stringify(this.importScripts) + ";\n"
  src += "var definitions = {};\n"

  _.forEach(this.definitions, function( definition ) {
    src += " definitions['" + definition.key + "'] = " + definition.val + ";\n"
  })

  src += ";(" + function(){

    function loadScripts( callback ) {
      var alloaded = false

      function next() {
        var src = importScripts.shift()
        if(alloaded || !src) {
          alloaded = true
          return callback()
        }
        var script = document.createElement('script')
        script.onload = function() {
          next()
        }
        document.body.appendChild( script )
        script.src = src
      }
      next()
    }


    self.onmessage = function( event ) {
      var data = JSON.parse(event.data);
      loadScripts(function() {
        if( data.result )
          return
        try {
          var result = definitions[data.command].apply(this, data.args);
          var out = { messageId: data.messageId, result: result };
          postMessage( JSON.stringify(out), domain );
        }
        catch( exception ) {
          var message = { messageId: data.messageId, exception: { type: exception.name, message: exception.message } };
          postMessage( JSON.stringify(message), domain );
        }
      })
    }


  }.toString() + ")();\n"

  script.innerHTML = src

  window.document.body.appendChild( this._iframe )

  this._iframe.contentWindow.addEventListener( 'message', _.bind( this.iframeOnMessageHandler, this ) )

  this._iframe.contentDocument.body.appendChild( script )

}

/*
 * Terminate the worker
 * @public
 * @function
*/
BackgroundWorker.prototype.terminate = function() {
  if( BackgroundWorker.hasWorkerSupport() ) {
    if( !this._worker )
      throw new Error('BackgroundWorker has no worker to terminate')
    return this._worker.terminate()
  }
  else if( this._iframe ){
    this._iframe.remove()
  }
}

/*
 * Get a uniqie messageid to identify a worker message transaction
 * @public
 * @function
 * @returns {int}
*/
BackgroundWorker.prototype.getUniqueMessageId = function() {
  return this._messageId++
}

/*
 * Define a command on the worker
 * @public
 * @function
*/
BackgroundWorker.prototype.define = function( key, val ) {
  this.definitions.push({ key: key, val: val })
}

/*
 * Run a given function defined in the BackgroundWorker
 * @public
 * @function
 * @param {string} command - command to run
 * @param {array} args - arguemnts to apply to command
 * @returns {Promise}
*/
BackgroundWorker.prototype.run = function( command, args ) {
  var messageId, message, handler, task, worker

  messageId = this.getUniqueMessageId()
  message = { command: command, args: args, messageId: messageId }

  handler = {}

  task = new Promise(function(resolve, reject) {
    handler.resolve = resolve
    handler.reject = reject
  })

  this._messagehandlers[ messageId ] = handler

  if( BackgroundWorker.hasWorkerSupport() ) {
    this._worker.postMessage( JSON.stringify(message) )
  }
  else {
    this._iframe.contentWindow.postMessage( JSON.stringify(message), this.domain )
  }

  return task
}

/*
 * Handle worker messages
 * @public
 * @function
 * @event
*/
BackgroundWorker.prototype.workerOnMessageHandler = function( event ) {
  var data, messagehandler

  data = JSON.parse( event.data )

  messagehandler = this._messagehandlers[ data.messageId ]

  if( data.exception )
    return messagehandler.reject( this.createExceptionFromMessage( data.exception ) )

  messagehandler.resolve( data.result )
}

/*
 * Handle iframe messages
 * @public
 * @function
 * @event
*/
BackgroundWorker.prototype.iframeOnMessageHandler = function( event ) {
  var data, messagehandler

  data = JSON.parse( event.data )

  if(data.command) return null

  messagehandler = this._messagehandlers[ data.messageId ]

  if( data.exception )
    return messagehandler.reject( this.createExceptionFromMessage( data.exception ) )

  messagehandler.resolve( data.result )

}


/*
 * Create a exception by an obect describing it
 * @public
 * @function
 * @param {object} exception
 * @param {string} exception.type
 * @param {string} exception.message
 * @returns {Error}
*/
BackgroundWorker.prototype.createExceptionFromMessage = function( exception ) {
  var type, message

  try {
    type = typeof global[exception.type] == 'function' ? global[exception.type] : Error
  }
  catch( exception ) {
    type = Error
  }

  message = exception.message

  return new type( message )
}

/*
 * Handle worker error
 * @public
 * @function
 * @event
*/
BackgroundWorker.prototype.workerOnErrorHandler = function( event ) {
  var message, error, errorType, errorMessage

  event.preventDefault()

  message = event.message
  error = message.match(/Uncaught\s([a-zA-Z]+)\:(.*)/)

  try {
    errorType = typeof global[error[1]] == 'function' ? global[error[1]] : Error
    errorMessage = typeof global[error[1]] == 'function' ? error[2] : message
  }
  catch( exception ) {
    errorType = Error
    errorMessage = message
  }

  error = new errorType( errorMessage )

  this.emit( 'exception', error )
}

/*
 * Get the sourcecode for this worker
 * @public
 * @function
 * @returns {string}
*/
BackgroundWorker.prototype.getWorkerSourcecode = function() {
  var src

  src = ""

  if( this.importScripts.length )
    src += "importScripts( '" + this.importScripts.join("','") + "' );\n"

  src += " var definitions = {};"

  _.forEach(this.definitions, function( definition ) {
    src += " definitions['" + definition.key + "'] = " + definition.val + ";"
  })

  src += "self.onmessage = function( event ) {  " +
           "var data = JSON.parse(event.data);" +
           "try {" +
              "var result = definitions[data.command].apply(this, data.args);" +
              "var out = { messageId: data.messageId, result: result };" +
              "this.postMessage( JSON.stringify(out) );" +
           "}" +
           "catch( exception ) {" +
             "var message = { messageId: data.messageId, exception: { type: exception.name, message: exception.message } };" +
             "this.postMessage(JSON.stringify(message));" +
           "}" +
         "};"

  return src
}
