var fs = require("fs")
  , child_process = require("child_process")
  , path = require("path")
  , chain = require("slide").chain
  , asyncMap = require("slide").asyncMap
  , TapProducer = require("./tap-producer.js")
  , TapConsumer = require("./tap-consumer.js")
  , assert = require("./tap-assert.js")
  , inherits = require("inherits")
  , util = require("util")
  , glob = require("glob")
  , doCoverage = process.env.TAP_COV
               || process.env.npm_package_config_coverage
               || process.env.npm_config_coverage

module.exports = Runner

inherits(Runner, TapProducer)

function Runner (options, cb) {
  this.options = options

  var diag = this.options.diag
  var dir = this.options.argv.remain
  TapProducer.call(this, diag)

  this.doCoverage = doCoverage

  if (dir) {
    this.run(dir, cb)
  }
}


Runner.prototype.run = function() {
  var self = this
    , args = Array.prototype.slice.call(arguments)
    , cb = args.pop() || finish

  function finish (er) {
    if (er) {
      self.emit("error", er)
    }
    self.end()
  }

  if (Array.isArray(args[0])) {
    args = args[0]
  }
  self.runFiles(args, "", cb)
}

Runner.prototype.runDir = function (dir, cb) {
  var self = this
  fs.readdir(dir, function (er, files) {
    if (er) {
      self.write(assert.fail("failed to readdir " + dir, { error: er }))
      self.end()
      return
    }
    files = files.sort(function(a, b) {
      return a > b ? 1 : -1
    })
    files = files.filter(function(f) {
      return !f.match(/^\./)
    })
    files = files.map(function(file) {
      return path.resolve(dir, file)
    })

    self.runFiles(files, path.resolve(dir), cb)
  })
}


// glob the filenames so that test/*.js works on windows
Runner.prototype.runFiles = function (files, dir, cb) {
  var self = this
  var globRes = []
  chain(files.map(function (f) {
    return function (cb) {
      glob(f, function (er, files) {
        if (er)
          return cb(er)
        globRes.push.apply(globRes, files)
        cb()
      })
    }
  }), function (er) {
    if (er)
      return cb(er)
    runFiles(self, globRes, dir, cb)
  })
}

function runFiles(self, files, dir, cb) {
  chain(files.map(function(f) {
    return function (cb) {
      if (self._bailedOut) return
      var relDir = dir || path.dirname(f)
        , fileName = relDir === "." ? f : f.substr(relDir.length + 1)

      self.write(fileName)
      fs.lstat(f, function(er, st) {
        if (er) {
          self.write(assert.fail("failed to stat " + f, {error: er}))
          return cb()
        }

        var cmd = f, args = [], env = {}

        if (path.extname(f) === ".js") {
          cmd = "node"
          if (self.options.gc) {
            args.push("--expose-gc")
          }
          args.push(fileName)
        } else if (path.extname(f) === ".coffee") {
          cmd = "coffee"
          args.push(fileName)
        } else {
          // Check if file is executable
          if ((st.mode & 0100) && process.getuid) {
            if (process.getuid() != st.uid) {
              return cb()
            }
          } else if ((st.mode & 0010) && process.getgid) {
            if (process.getgid() != st.gid) {
              return cb()
            }
          } else if ((st.mode & 0001) == 0) {
            return cb()
          }
        }

        if (st.isDirectory()) {
          return self.runDir(f, cb)
        }

        for (var i in process.env) {
          env[i] = process.env[i]
        }
        env.TAP = 1

        if (self.doCoverage) {
          args[0] = path.join(relDir, args[0])
          //console.log(args)
          var tap = '/Users/jmorrison/github/jrgm/node-tap/bin/tap.js'
          args.unshift(tap)
          args.unshift('run')
          cmd = '/Users/jmorrison/github/jrgm/node-tap/node_modules/.bin/cover'
          //console.log('cmd', cmd)
          //console.log('args', args)
        }

        var cp = child_process.spawn(cmd, args, { env: env, cwd: relDir })
          , out = ""
          , err = ""
          , tc = new TapConsumer()
          , childTests = [f]

        var timeout = setTimeout(function () {
          if (!cp._ended) {
            cp._timedOut = true
            cp.kill()
          }
        }, self.options.timeout * 1000)

        tc.on("data", function(c) {
          self.emit("result", c)
          self.write(c)
        })

        tc.on("bailout", function (message) {
          clearTimeout(timeout)
          console.log("# " + f.substr(process.cwd().length + 1))
          process.stderr.write(err)
          process.stdout.write(out + "\n")
          self._bailedOut = true
          cp._ended = true
          cp.kill()
        })

        cp.stdout.pipe(tc)
        cp.stdout.on("data", function (c) { out += c })
        cp.stderr.on("data", function (c) {
          if (self.options.stderr) process.stderr.write(c)
          err += c
        })

        cp.on("close", function (code, signal) {
          if (cp._ended) return
          cp._ended = true
          var ok = !cp._timedOut && code === 0
          clearTimeout(timeout)
          //childTests.forEach(function (c) { self.write(c) })
          var res = { name: path.dirname(f).replace(process.cwd() + "/", "")
                          + "/" + fileName
                    , ok: ok
                    , exit: code }

          if (cp._timedOut)
            res.timedOut = cp._timedOut
          if (signal)
            res.signal = signal

          if (err) {
            res.stderr = err
            if (tc.results.ok &&
                tc.results.tests === 0 &&
                !self.options.stderr) {
              // perhaps a compilation error or something else failed.
              // no need if stderr is set, since it will have been
              // output already anyway.
              console.error(err)
            }
          }

          // tc.results.ok = tc.results.ok && ok
          tc.results.add(res)
          res.command = [cmd].concat(args).map(JSON.stringify).join(" ")
          self.emit("result", res)
          self.emit("file", f, res, tc.results)
          self.write(res)
          self.write("\n")
          cb()
        })
      })
    }
  }), cb)

  return self
}
