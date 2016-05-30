//
// THIS APP REQUIRE FFMPEG AND liblamemp3  CODEC !!!
//

const electron = require('electron');
// Module to control application life.
const app = electron.app;
const Menu = electron.Menu;
// Module to create native browser window.
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow
function createWindow () {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 600,
    minWidth: 1024,
    icon: __dirname + '/public/img/tgf/icon_circle.png'
  });
  // and load the index.html of the app.
  mainWindow.loadURL(`file://${__dirname}/public/index.html`);

  // Open the DevTools.
  mainWindow.webContents.openDevTools()
  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow)
// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow()
  }
})

var fs = require('fs-sync');
var ofs = require('fs');  // old fs
var util = require('util');
var port = 80;
var request = require('request');
var id3 = require('node-id3');
var random = require('random-gen');
var os = require('os');
var async = require('async');
var bodyParser = require('body-parser');
var youtubedl = require('youtube-dl');
var fid = require('fast-image-downloader');
var video2mp3 = require('video2mp3');
var sanitize = require("sanitize-filename");
var ffmpeg = require('fluent-ffmpeg');

var server = require('http').createServer();

// CONVERT VARS

var maxProcess = 5;     //max simul
var processList = 0;   //list of current processing items
var waitingList = 0;   // list of items inside the waiting queue

//

var fidOpt = {
  TIMEOUT : 2000, // timeout in ms
  ALLOWED_TYPES : ['jpg', 'png'] // allowed image types
};

//set the ffmpeg binary location (path)
if(os.platform() === 'win32'){
     var ffmpegPath = './bin/ffmpeg/ffmpeg.exe'
 }else{
     var ffmpegPath = './bin/ffmpeg/ffmpeg'
 }
ffmpeg.setFfmpegPath(ffmpegPath);

// clean function remove all temp thumbnails and mp3

// dir cleaner function
var rmDir = function(dirPath, removeSelf) {
  if (removeSelf === undefined)
    removeSelf = true;
  try { var files = ofs.readdirSync(dirPath); }
  catch(e) { return; }
  if (files.length > 0)
    for (var i = 0; i < files.length; i++) {
      var filePath = dirPath + '/' + files[i];
      if (ofs.statSync(filePath).isFile())
        fs.remove(filePath);
      else
        rmDir(filePath);
    }
  if (removeSelf)
    ofs.rmdirSync(dirPath);
};

// create the "exports" folder
var p = "./exports";
if (!ofs.existsSync(p)){
    ofs.mkdirSync(p);
}


rmDir('./public/img/temps',false);
rmDir('./exports',false);
console.log("Temp files cleaned");

var config = {};

// retreive config file
config = fs.readJSON("config.json");

var io = require('socket.io')(server);
server.listen(8080);

io.on('connection', function (socket){

  socket.on('fileRequest', function (data) {
    var session = {
      id : random.alphaNum(16),
      processEnded : 0,
      files : data.files,
      path : data.path
    }
    var tempPath = "./exports/"+session.id;

    //create the temp session path
    if (!ofs.existsSync(tempPath)){
      ofs.mkdirSync(tempPath);
    }

    var processEnded = 0;

    for (var fileIndex = 0; fileIndex < session.files.length; fileIndex++) {
      requestFileProcess(session,fileIndex,socket);
    }
  });

  // retreive the info for a specific file
  socket.on('fileInfo', function (data) {
    var fileUrl = decodeURIComponent(data.url);
  	retreiveFileInfos(fileUrl,function(err,infos){
      if(err){
        socket.emit("yd_event",{event:"file_info_error",data:{error:err}});
        return;
      }
      socket.emit("yd_event",{event:"file_info",data:infos});
    });
  });
});

function processFileDl(session,fileIndex,socket,callback){
  var file = session.files[fileIndex];
  fid(file.image, fidOpt.TIMEOUT, fidOpt.ALLOWED_TYPES, "", function(err, img){ //download the file image
    if (err) {
      callback(err);  //return error
      return;
    }

    var dir = "./public/img/temps"; // create the temp folder if not exist (thumbnail)
    if (!fs.exists(dir)){
        fs.mkdir(dir);
    }

    dir = "./exports/"+session.id; // create the export folder if not exist (mp3)
    if (!fs.exists(dir)){
        fs.mkdir(dir);
    }

    var imgPath = "./public/img/temps/"+session.id+"-"+fileIndex+"."+img.fileType.ext;
    fs.write(imgPath, img.body);
    file.image = imgPath;
    file.exportPath = dir+"/"+fileIndex+".mp4";
    //
    // START DOWNLOAD //
    //

    // send the file size every 500 ms
    file.lastProgress = 0;
    var progressPing = setInterval(function(){
      var stats = ofs.statSync(file.exportPath);
      var fileSizeInBytes = stats["size"];
      var sinfo = {
        session : session.id,
        index : fileIndex,
        size : fileSizeInBytes
      }
      if(sinfo.size > file.lastProgress){  //send progress only if progress
        file.lastProgress = sinfo.size;

        socket.emit("yd_event",{event:"progress",data:sinfo});
      }

    },1000);

    var ytdlProcess = youtubedl(file.webpage_url,
      // Optional arguments passed to youtube-dl.
      ['-x'],
      // Additional options can be given for calling `child_process.execFile()`.
      { cwd: __dirname });

    ytdlProcess.pipe(ofs.createWriteStream('./exports/'+session.id+'/'+fileIndex+'.mp4'));

    // Will be called when the download starts.
    ytdlProcess.on('info', function (info) {
      socket.emit('yd_event', {event: 'file_download_started', data: fileIndex}); // send a status for this file
    });

    ytdlProcess.on('error', function error(err) {
      console.log(err);
      socket.emit('yd_event', {event: 'file_error', data: {index: fileIndex, error: err}});
    });

    ytdlProcess.on('end', function() {  // DL ending
      processFileConvert(file,function(err,file){ //convert the mp4 to mp3
        if(err){                        //stop all if error
          return callback(err);
        }
        processFileTag(file,function(err,file){    //tag the given mp3
          if(err){                        //stop all if error
            return callback(err);
          }
          callback(null,file);   //return the final result
        });
      });
      //file downloaded, apply the tags
      socket.emit("yd_event",{event:"file_finished",data:{index:fileIndex}});

      clearInterval(progressPing);  //end the filesize ping
    });
  });
}

function processFileConvert(file,callback){ //convert the given file from mp4 to mp3
  var mainFormat = '.mp4';
  var newFormat = '.mp3';
  // find the index of last time word was used
  // please note lastIndexOf() is case sensitive
  var n = file.exportPath.toLowerCase().lastIndexOf(mainFormat.toLowerCase());
  var pat = new RegExp(mainFormat, 'i');
  // slice the string in 2, one from the start to the lastIndexOf
  // and then replace the word in the rest
  var mp3ExportPath = file.exportPath.slice(0, n) + file.exportPath.slice(n).replace(pat, newFormat);

  video2mp3.convert(file.exportPath, {mp3path: mp3ExportPath, }, function (err) {
    if (err){
      return callback(err);
    }
    // set the new exportPath
    var vep = file.exportPath;
    file.exportPath = mp3ExportPath;
    file.videoExportPath = vep;
    // confirm converting succes and return the obj with the new exportPath
    callback(null,file);
  });
}

function processFileTag(file,callback){ //tags the given file
  // tags + little ad :)
  var tags = {
    encodedBy : "tagifier.net",
    remixArtist : "tagifier.net",
    comment : "tagifier.net",
    title : file.title,
    artist : file.artist,
    composer : file.artist,
    image : file.image,
    album : file.album,
    year : file.year
  }

  var tagsWrite = id3.write(tags, file.exportPath);   //Pass tags and filepath
  if(!tagsWrite){
    callback(tagsWrite);  //return error
    return;
  }

  if (fs.exists(file.image)) {   //remove the temp thumbnail
    fs.remove(file.image);
  }

  callback(null,file);  //success, return the file for socket sending
}

 //used to insert a file inside a waiting queue and process it when possible
function requestFileProcess(session,fileIndex,socket){
  waitingList++;  //increment waiting list count
  var fileQueue = setInterval(function(){   //check every 5 sec if the process can start

    if(processList >= maxProcess){
      return; //no place available... retry in 5s
    }

    //remove from waiting list and place to process list
    waitingList--;
    processList++;
    clearInterval(fileQueue); //stop the loop
    processFileDl(session,fileIndex,socket,function(err,data){
      processList--;  // process ended (give a place to the waiting list)
      if(err){
        console.log("--- PROCESSING ERROR ---");
        console.log("(Session "+session.id+" | File "+fileIndex+")");
        console.log(err);
        socket.emit('yd_event', {event: 'file_error', data: {index: fileIndex, error: err}});
        session.processEnded++;
        if(session.processEnded == session.files.length){ //if all files are converted
          socket.emit("yd_event",{event:"process_error",data:{err:err}});
        }
        return;
      }
      if(!err){
        //move the downloaded file to it final folder
        moveFile(session,fileIndex,function(err,filePath){
          if(err){
            socket.emit('yd_event', {event: 'file_error', data: {index: fileIndex, error: err}});
          }
          session.processEnded++;
          if(session.processEnded == session.files.length){ //if all files are converted
            socket.emit("yd_event",{event:"finished",data:{path:session.path}});
          }
        });
      }
    });
  },500);
}

function retreiveFileSize(info){
  var f = 0;
  for (var i = 0; i < info.formats.length; i++) {
    if(info.formats[i].filesize){
      if(info.formats[i].filesize > f){
        f = info.formats[i].filesize;
      }
    }
  }
  return f;
}

function retreiveFileInfos(url,callback){
  youtubedl.getInfo(url, "", function(err, info) {
    if (err) {
      callback(err,"");
    }
    else {
      callback("",info);
    }
  });
}

function moveFile(session,fileIndex,callback){
  var file = session.files[fileIndex];
  //create the exportDir if not exist yet
  if (!ofs.existsSync(session.path)){
      ofs.mkdirSync(session.path);
  }

  //prevent invalid char inside filename
  var nFileName = sanitize(file.fileName);

  //copy the file , this method prevent a nodejs error with rename
  copyFile(file.exportPath,session.path+"/"+nFileName+".mp3",function(err){
    if(err){
      return callback(err);
    }
    if(ofs.existsSync(file.exportPath)){
      ofs.unlink(file.exportPath);
      callback(null, session.path+"/"+nFileName+".mp3");
    }
  });

}

var returnDur = function(dur){
	var d = {
		h : 0,
		m : 0,
		s : 0
	};
	var dur = dur.split(":");
	if(dur.length == 3){
		d.h = dur[0];
		d.m = dur[1];
		d.s = dur[2];
	}
	if(dur.length == 2){
		d.m = dur[0];
		d.s = dur[1];
	}
	else{
		d.s = dur[0];
	}

  var f = d.s+(d.m*60)+((d.h*60)*60);

	return f;
}

// convert an $_get object to a string list
function getToStr(get){
  var separator = "?";
  var ret = "";
  for(var key in get) {
      ret+=""+separator+""+key+"="+get[key];
      separator = "&";
  }
  return ret;
}

function copyFile(source, target, cb) {
  var cbCalled = false;

  var rd = ofs.createReadStream(source);
  rd.on("error", function(err) {
    done(err);
  });
  var wr = ofs.createWriteStream(target);
  wr.on("error", function(err) {
    done(err);
  });
  wr.on("close", function(ex) {
    done();
  });
  rd.pipe(wr);

  function done(err) {
    if (!cbCalled) {
      cb(err);
      cbCalled = true;
    }
  }
}

//app.use('/', express.static(__dirname + '/public/'));
