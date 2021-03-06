// Generated by CoffeeScript 1.9.0
var Account, AccountConfigError, Imap, ImapPool, TimeoutError, async, connectionID, log, rawImapLog, xoauth2, _ref,
  __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

_ref = require('../utils/errors'), AccountConfigError = _ref.AccountConfigError, TimeoutError = _ref.TimeoutError;

log = require('../utils/logging')({
  prefix: 'imap:pool'
});

rawImapLog = require('../utils/logging')({
  prefix: 'imap:raw'
});

Account = require('../models/account');

Imap = require('./connection');

xoauth2 = require('xoauth2');

async = require("async");

connectionID = 1;

ImapPool = (function() {
  var _typeConnectionError;

  ImapPool.instances = {};

  ImapPool.get = function(accountID) {
    var _base;
    if ((_base = this.instances)[accountID] == null) {
      _base[accountID] = new ImapPool(accountID);
    }
    return this.instances[accountID];
  };

  ImapPool.test = function(account, callback) {
    var pool;
    pool = new ImapPool(account);
    return pool.doASAP(function(imap, cbRelease) {
      return cbRelease(null, 'OK');
    }, function(err) {
      pool.destroy();
      return callback(err);
    });
  };

  function ImapPool(accountOrID) {
    this._deQueue = __bind(this._deQueue, this);
    this._closeConnections = __bind(this._closeConnections, this);
    if (typeof accountOrID === 'string') {
      log.debug(this.id, "new pool " + accountOrID);
      this.id = this.accountID = accountOrID;
      this.account = null;
    } else {
      log.debug(this.id, "new pool Object#" + accountOrID.id);
      this.id = this.accountID = accountOrID.id;
      this.account = accountOrID;
    }
    this.parallelism = 1;
    this.tasks = [];
    this.pending = {};
    this.failConnectionCounter = 0;
    this.connecting = 0;
    this.connections = [];
    this.freeConnections = [];
  }

  ImapPool.prototype.destroy = function() {
    log.debug(this.id, "destroy");
    if (this.closingTimer) {
      clearTimeout(this.closingTimer);
    }
    this._closeConnections();
    return delete ImapPool.instances[this.accountID];
  };

  ImapPool.prototype._removeFromPool = function(connection) {
    var index;
    log.debug(this.id, "remove " + connection.connectionID + " from pool");
    index = this.connections.indexOf(connection);
    if (index > -1) {
      this.connections.splice(index, 1);
    }
    index = this.freeConnections.indexOf(connection);
    return this.freeConnections.splice(index, 1);
  };

  ImapPool.prototype._getAccount = function() {
    log.debug(this.id, "getAccount");
    return Account.findSafe(this.accountID, (function(_this) {
      return function(err, account) {
        if (err) {
          return _this._giveUp(err);
        }
        _this.account = account;
        return _this._deQueue();
      };
    })(this));
  };

  ImapPool.prototype._makeConnection = function() {
    var generator;
    log.debug(this.id, "makeConnection");
    this.connecting++;
    if (this.account.oauthProvider === "GMAIL") {
      generator = xoauth2.createXOAuth2Generator({
        user: this.account.login,
        clientSecret: '1gNUceDM59TjFAks58ftsniZ',
        clientId: '260645850650-2oeufakc8ddbrn8p4o58emsl7u0r0c8s.apps.googleusercontent.com',
        refreshToken: this.account.oauthRefreshToken,
        accessToken: this.account.oauthAccessToken
      });
    }
    return async.waterfall([
      (function(_this) {
        return function(callback) {
          log.debug("async.waterfall 1");
          if (_this.account.oauthProvider === "GMAIL") {
            return generator.generateToken(function(err, token) {
              log.debug("b64 xoauth2 token : ", token);
              return callback(err, token);
            });
          } else {
            return callback(null, null);
          }
        };
      })(this), (function(_this) {
        return function(token, callback) {
          var options;
          if (token) {
            options = {
              user: _this.account.login,
              xoauth2: token,
              host: "imap.gmail.com",
              port: 993,
              tls: true,
              tlsOptions: {
                rejectUnauthorized: false
              }
            };
          } else {
            options = {
              user: _this.account.imapLogin || _this.account.login,
              password: _this.account.password,
              xoauth2: token,
              host: _this.account.imapServer,
              port: parseInt(_this.account.imapPort),
              tls: (_this.account.imapSSL == null) || _this.account.imapSSL,
              tlsOptions: {
                rejectUnauthorized: false
              }
            };
          }
          log.debug("async.waterfall 2");
          log.debug(options);
          return callback(null, options);
        };
      })(this)
    ], (function(_this) {
      return function(err, options) {
        var imap, onConnError, wrongPortTimeout;
        log.debug("async.waterfall final callback");
        if (err) {
          log.error(err);
        }
        imap = new Imap(options);
        log.debug(options);
        onConnError = _this._onConnectionError.bind(_this, imap);
        imap.connectionID = 'conn' + connectionID++;
        imap.connectionName = options.host + ":" + options.port;
        imap.on('error', onConnError);
        imap.once('ready', function() {
          log.debug(_this.id, "imap ready");
          imap.removeListener('error', onConnError);
          clearTimeout(wrongPortTimeout);
          return _this._onConnectionSuccess(imap);
        });
        imap.connect();
        return wrongPortTimeout = setTimeout(function() {
          var _ref1, _ref2;
          log.debug(_this.id, "timeout 10s");
          imap.removeListener('error', onConnError);
          onConnError(new TimeoutError("Timeout connecting to " + (((_ref1 = _this.account) != null ? _ref1.imapServer : void 0) + ":" + ((_ref2 = _this.account) != null ? _ref2.imapPort : void 0))));
          return imap.destroy();
        }, 10000);
      };
    })(this));
  };

  ImapPool.prototype._onConnectionError = function(connection, err) {
    log.debug(this.id, "connection error on " + connection.connectionName);
    this.connecting--;
    this.failConnectionCounter++;
    if (this.failConnectionCounter > 2) {
      return this._giveUp(_typeConnectionError(err));
    } else {
      return setTimeout(this._deQueue, 5000);
    }
  };

  ImapPool.prototype._onConnectionSuccess = function(connection) {
    log.debug(this.id, "connection success");
    connection.once('close', this._onActiveClose.bind(this, connection));
    connection.once('error', this._onActiveError.bind(this, connection));
    this.connections.push(connection);
    this.freeConnections.push(connection);
    this.connecting--;
    this.failConnectionCounter = 0;
    return process.nextTick(this._deQueue);
  };

  ImapPool.prototype._onActiveError = function(connection, err) {
    var name;
    name = connection.connectionName;
    log.error("error on active imap socket on " + name, err);
    this._removeFromPool(connection);
    try {
      return connection.destroy();
    } catch (_error) {}
  };

  ImapPool.prototype._onActiveClose = function(connection, err) {
    var task;
    log.error("active connection " + connection.connectionName + " closed", err);
    task = this.pending[connection.connectionID];
    if (task) {
      delete this.pending[connection.connectionID];
      if (typeof task.callback === "function") {
        task.callback(err || new Error('connection was closed'));
      }
      task.callback = null;
    }
    return this._removeFromPool(connection);
  };

  ImapPool.prototype._closeConnections = function() {
    var connection;
    log.debug(this.id, "closeConnections");
    this.closingTimer = null;
    connection = this.connections.pop();
    while (connection) {
      connection.expectedClosing = true;
      connection.end();
      connection = this.connections.pop();
    }
    return this.freeConnections = [];
  };

  ImapPool.prototype._giveUp = function(err) {
    var task, _results;
    log.debug(this.id, "giveup", err);
    delete this.account;
    task = this.tasks.pop();
    _results = [];
    while (task) {
      task.callback(err);
      _results.push(task = this.tasks.pop());
    }
    return _results;
  };

  ImapPool.prototype._deQueue = function() {
    var free, full, imap, moreTasks, task;
    free = this.freeConnections.length > 0;
    full = this.connections.length + this.connecting >= this.parallelism;
    moreTasks = this.tasks.length > 0;
    if (!this.account) {
      return this._getAccount();
    }
    if (this.account.isTest()) {
      if (moreTasks) {
        task = this.tasks.pop();
        if (typeof task.callback === "function") {
          task.callback(null);
        }
        process.nextTick(this._deQueue);
      }
      return;
    }
    if (moreTasks) {
      if (this.closingTimer) {
        clearTimeout(this.closingTimer);
      }
      if (free) {
        imap = this.freeConnections.pop();
        task = this.tasks.pop();
        this.pending[imap.connectionID] = task;
        return task.operation(imap, (function(_this) {
          return function(err) {
            var arg, args;
            args = (function() {
              var _i, _len, _results;
              _results = [];
              for (_i = 0, _len = arguments.length; _i < _len; _i++) {
                arg = arguments[_i];
                _results.push(arg);
              }
              return _results;
            }).apply(_this, arguments);
            _this.freeConnections.push(imap);
            delete _this.pending[imap.connectionID];
            process.nextTick(function() {
              var _ref1;
              if ((_ref1 = task.callback) != null) {
                _ref1.apply(null, args);
              }
              return task.callback = null;
            });
            return process.nextTick(_this._deQueue);
          };
        })(this));
      } else if (!full) {
        return this._makeConnection();
      }
    } else {
      return this.closingTimer != null ? this.closingTimer : this.closingTimer = setTimeout(this._closeConnections, 5000);
    }
  };

  _typeConnectionError = function(err) {
    var typed;
    typed = err;
    if (err.textCode === 'AUTHENTICATIONFAILED') {
      typed = new AccountConfigError('auth', err);
    }
    if (err.code === 'ENOTFOUND' && err.syscall === 'getaddrinfo') {
      typed = new AccountConfigError('imapServer', err);
    }
    if (err.code === 'EHOSTUNREACH') {
      typed = new AccountConfigError('imapServer', err);
    }
    if (err.source === 'timeout-auth') {
      typed = new AccountConfigError('imapTLS', err);
    }
    if (err instanceof TimeoutError) {
      typed = new AccountConfigError('imapPort', err);
    }
    return typed;
  };

  ImapPool.prototype._wrapOpenBox = function(cozybox, operation) {
    var wrapped;
    return wrapped = (function(_this) {
      return function(imap, callback) {
        return imap.openBox(cozybox.path, function(err, imapbox) {
          var newUidvalidity, oldUidvalidity;
          if (err) {
            return callback(err);
          }
          if (!imapbox.persistentUIDs) {
            return callback(new Error('UNPERSISTENT UID'));
          }
          oldUidvalidity = cozybox.uidvalidity;
          newUidvalidity = imapbox.uidvalidity;
          if (oldUidvalidity && oldUidvalidity !== newUidvalidity) {
            log.error("uidvalidity has changed");
            return cozybox.recoverChangedUIDValidity(imap, function(err) {
              var changes;
              changes = {
                uidvalidity: newUidvalidity
              };
              return cozybox.updateAttributes(changes, function(err) {
                return wrapped(imap, callback);
              });
            });
          } else {
            return operation(imap, imapbox, function(err, arg1, arg2, arg3) {
              var changes;
              log.debug(_this.id, "wrapped operation completed");
              if (err) {
                return callback(err);
              }
              if (!oldUidvalidity) {
                changes = {
                  uidvalidity: newUidvalidity
                };
                return cozybox.updateAttributes(changes, function(err) {
                  if (err) {
                    return callback(err);
                  }
                  return callback(null, arg1, arg2, arg3);
                });
              } else {
                return callback(null, arg1, arg2, arg3);
              }
            });
          }
        });
      };
    })(this);
  };

  ImapPool.prototype.doASAP = function(operation, callback) {
    this.tasks.unshift({
      operation: operation,
      callback: callback
    });
    return this._deQueue();
  };

  ImapPool.prototype.doLater = function(operation, callback) {
    this.tasks.push({
      operation: operation,
      callback: callback
    });
    return this._deQueue();
  };

  ImapPool.prototype.doASAPWithBox = function(cozybox, operation, callback) {
    operation = this._wrapOpenBox(cozybox, operation);
    this.tasks.unshift({
      operation: operation,
      callback: callback
    });
    return this._deQueue();
  };

  ImapPool.prototype.doLaterWithBox = function(cozybox, operation, callback) {
    operation = this._wrapOpenBox(cozybox, operation);
    this.tasks.push({
      operation: operation,
      callback: callback
    });
    return this._deQueue();
  };

  return ImapPool;

})();

module.exports = {
  get: function(accountID) {
    return ImapPool.get(accountID);
  },
  test: function(accountID, cb) {
    return ImapPool.test(accountID, cb);
  }
};
