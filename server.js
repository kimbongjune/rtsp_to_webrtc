/**
 * 
 * 영상 변환 서버 파일
 * kurento media 서버와 통신하여 rtsp 영상을 webRTC로 변환한다.
 * 
 * @author kbj.
 * @since 2023-10-13
 * @version 1.0.0
 * 
 * <pre>
 * << 개정이력(Modefication Information) >>
 *
 * 수정일       		수정자      수정내용 
 * ================================= 
 * 2023-10-13   kbj.    최초생성 
 *
 * </pre>
 *
 */

const path = require('path');
const { URL } = require('url');
const express = require('express');
const minimist = require('minimist');
const kurento = require('kurento-client');
const bodyParser = require('body-parser');
const { sequelize, rtspTable, Op } = require('./db/db');
const cors = require('cors');
const net = require('net');
const http = require('http');
const socketIo = require('socket.io');
const apiRoute = require('./routes/api');
const manageRoute = require('./routes/manage');
const { instrument } = require("@socket.io/admin-ui");
const startScheduler = require('./scheduler/scheduler');
const { v4: uuidv4 } = require('uuid');
const {Base64, hex_md5} = require('./static/js/base64');
const { default: axios } = require('axios');
const FormData = require('form-data');

//npm 아규먼트
var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'http://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var app = express();
//bodyParser 미들웨어 추가 post 요청 데이터를 객체로 받기위해 사용
app.use(bodyParser.json());
//cors 허용 IP 리스트. 추후에 특정 ip만 허용하게 변경
const allowedOrigins = ['*'];
  
app.use(cors(
    {
        origin : allowedOrigins
    }
));
//정적 리소스 설정 /static : /
app.use(express.static(path.join(__dirname, 'static')));
//정적 리소스 설정 /static/recorders : /recorders
app.use('/recorders', express.static(path.join(__dirname, 'static', "recorders")));
//정적 리소스 설정 /static/recorders : /recorders
app.use('/auth-test', express.static(path.join(__dirname, 'static', "decodeTest", "decode-test")));
//정적 리소스 설정 /static/bower_components : /bower_components
app.use('/bower_components', express.static(path.join(__dirname, 'static', "bower_components")));
//정적 리소스 설정 /static/node_modules/@socket.io/admin-ui/ui/dist/index.html : /socket-panel
app.use('/socket-panel', express.static(path.join(__dirname, 'node_modules', '@socket.io', 'admin-ui', 'ui', 'dist')));
//라우팅 설정 /api
app.use('/api', apiRoute);
//라우팅 설정 /manage
app.use('/manage', manageRoute);

//RTSP 포트
//const RTSP_PORT = 554 //운영용 포트
const RTSP_PORT = 1935  //테스트용 포트

//express 서버 인스턴스 생성
const server = http.createServer(app);
//웹소켓 서버 설정
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true
    }
});

//socket.io admin 설정
instrument(io, { 
    auth: false,
});

//express 서버 ip
const asUrl = new URL(argv.as_uri);
//express서버 port
var port = asUrl.port;

//express 서버 실행
server.listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + asUrl + ' with a WebRTC capable browser');
    //저장 영상 삭제를 위한 스케줄러 실행
    startScheduler()
});

//소켓 메시지 전송 공통함수
const sendMessage = (socket, id, message) =>{
    socket.emit(id, message);
}

//ICE Candidate 후보군을 관리하는 객체
var candidatesQueue = {};
//kurentoClient 인스턴스 객체
var kurentoClient = null;
//recorder, webRtcEndpoint, socket을 관리하는 객체
var viewers = {};

//rtsp 엔드포인트 tcp 헬스체크 함수
const checkTCPConnection = async (ip, port) => {
    return new Promise((resolve) => {
        const client = new net.Socket();

        client.connect(port, ip, () => {
            resolve({ ip, port, status: 'open', isOpen : true });
            client.destroy();
        });

        client.on('error', () => {
            resolve({ ip, port, status: 'closed', isOpen : false });
            client.destroy();
        });

        client.setTimeout(500, () => {
            resolve({ ip, port, status: 'closed', isOpen : false });
            client.destroy();
        });
    });
}

// const addresses = [
//     { ip: '210.99.70.120', port: 1935 },
//     { ip: '210.99.70.120', port: 1935 },
// ];

// Promise.all(addresses.map(addr => checkTCPConnection(addr.ip, addr.port)))
//     .then((results) => {
//         //console.log(results);
//         results.forEach(result => {
//             console.log(`${result.ip}:${result.port} is ${result.status}, open = ${result.isOpen}`);
//         });
//     });

//헬스체크 API
app.get('/health-check', async (req, res) => {
    let dataArray = req.query.carId;
    if (!dataArray) {
        return res.status(400).send({response : "error", message: "필수 파라미터(carId) 누락" });
    }

    if (!Array.isArray(dataArray)) {
        dataArray = [dataArray];
    }

    console.log(dataArray)
    try {
        const results = await rtspTable.findAll({
            where: {
                streaming_name: {
                    [Op.in]: dataArray
                }
            }
        });

        const checkedResponses = await Promise.all(dataArray.map(async carId => {
            const found = results.find(result => result.streaming_name === carId);
            //console.log(found)
            if (found) {
                const connectionResult = await checkTCPConnection(found.streaming_ip, RTSP_PORT);
                console.log(connectionResult)
                return {
                    ...found.dataValues,
                    status: connectionResult.status,
                    isOpen: connectionResult.isOpen,
                    response : "success"
                };
            } else {
                return { streaming_name: carId, message: `${carId} 차량에 대한 매핑 데이터가 없음`, response : "error" };
            }
        }));

        res.json(checkedResponses);
        
    } catch (error) {
        res.status(500).json({response : "error", message: error.message });
    }
});

//시퀄라이저 인스턴스 생성
sequelize.sync()
    .then(() => {
        console.log(`sequelize started`);
    })
    .catch(error => {
        console.error("Failed to connect to the database:", error);
    });

//웹소켓 연결 리스너
io.on('connection', (socket) => {
    //websocket rtcConnect 응답 처리 리스너, 무선호출명을 파라미터로 받아 데이터베이스를 조회하고 tcp 헬스체크를 진행함. 성공시 고유 UUID를 반환함.
    socket.on("rtcConnect", async(data) =>{
        try {
            console.log(data)
            if(data.streamingName === "" || !data.streamingName){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (streamingName) 누락`
                }
                sendMessage(socket, 'rtcConnectResponse', message)
                return;
            }
            const selectResult = await rtspTable.findOne({
                where: { streaming_name: data.streamingName }
            });
            
            if(!selectResult) {
                const message = {
                    response: 'error',
                    message: `${data.streamingName} 차량에 대한 매핑 데이터가 없음`
                }
                sendMessage(socket, 'rtcConnectResponse', message)
                return;
            }

            const rtspIP = selectResult.streaming_ip;
            const healthCheckResult = await checkTCPConnection(rtspIP, RTSP_PORT);

            if(!healthCheckResult.isOpen) {
                const message = {
                    response: 'error',
                    message: `${data.streamingName} 차량의 카메라가 꺼져있음`
                }
                sendMessage(socket, 'rtcConnectResponse', message)
                return;
            }
            
            console.log(selectResult.dataValues)
            let authData
            // 이노뎁 /nvrcgi/system/GetAuthenticationid
            //TODO 이노뎁, 세연 인포테크 등 인증 로직 추가 및 url 확인
            if(selectResult.dataValues.camera_type === "kedacom"){
                authData = await axios.get(`http://${selectResult.dataValues.streaming_ip}/kdsapi/link/authenticationid`,{
                    headers : {
                        "If-Modified-Since" :"0"
                    }
                })
                const regex = authData.data.match(/<authenticationid>(.*?)<\/authenticationid>/)

                if(regex && regex[1]){
                    const authenticationid = regex[1]
                    const encodedPassword = Base64.encode(
                        hex_md5(selectResult.dataValues.streaming_id + "," + selectResult.dataValues.streaming_password + "," + authenticationid)
                    );
                    selectResult.dataValues.authenticationid = authenticationid
                    selectResult.dataValues.encoded_password = encodedPassword
                }else{
                    const message = {
                        response: 'error',
                        message: `${data.streamingName} 차량의 카메라 계정인증 실패`
                    }
                    sendMessage(socket, 'rtcConnectResponse', message)
                    return;
                }
            }

            //이노뎁 nvrcgi/system/GetAuthenticationid <authenticationinfo type="7.0"><username>admin</username><password>ZDdmMjFhOTU0MTNlNjRiZWZmZTMwODUxMmZjNGUxNDU=</password><authenticationid>569005199c00b5</authenticationid></authenticationinfo>
            //이후 nvrcgi/system/Login <contentroot><authenticationinfo type="7.0"><username>admin</username><password>ZmY3NWY2NmJkMWJlN2RiMGU3MjRlNDA3M2I3NGY0Y2M=</password><authenticationid>569002199b948a</authenticationid></authenticationinfo><LoginReq/></contentroot>

            const streamUUID = uuidv4();
            selectResult.dataValues.streamUUID = streamUUID
            
            const message = {
                response: 'success',
                message: "차량 연결 성공",
                result : selectResult.dataValues
            }
            sendMessage(socket, 'rtcConnectResponse', message)
        }catch(error){
            const message = {
                response: 'error',
                message: "알 수 없는 에러 :"+error
            }
            sendMessage(socket, 'rtcConnectResponse', message)
        }
    })

    //websocket viewer 응답 처리 리스너, rtsp 영상을 쿠렌토 미디어 서버를 이용해 webRTC로 변환함
    socket.on('viewer', async (data) => {
        try {
            console.log(data)
            const streamUUID = data.streamUUID
            if(data.streamingName === "" || !data.streamingName){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (streamingName) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            if(data.rtspIp === "" || !data.rtspIp){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (rtspIp) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            if(data.disasterNumber === "" || !data.disasterNumber){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (disasterNumber) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            if(data.carNumber === "" || !data.carNumber){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (carNumber) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            if(data.streamingId === "" || !data.streamingId){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (streamingId) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            if(data.streamingPassword === "" || !data.streamingPassword){
                const message = {
                    response: 'error',
                    message: `필수 파라미터 (streamingPassword) 누락`,
                    streamUUID : data.streamUUID
                }
                sendMessage(socket, 'viewerResponse', message)
                return;
            }
            const rtspIp = generateRtspEndpoint(data.rtspIp, data.streamingId, data.streamingPassword, data.cameraType)
            const disasterNumber = data.disasterNumber
            const carNumber = data.carNumber
            //영상 변환 시작
            startViewer(streamUUID, socket, data.sdpOffer, rtspIp, disasterNumber, carNumber, data.streamingName, function(error, sdpAnswer) {
                if(error) {
                    const message = {
                        response: 'error',
                        message: error
                    }
                    sendMessage(socket, 'viewerResponse', message)
                } else {
                    const message = {
                        response: 'success',
                        sdpAnswer: sdpAnswer,
                        streamUUID : streamUUID
                    }
                    sendMessage(socket, 'viewerResponse', message)
                }
            });
        } catch(error) {
            console.log(error);
            const message = {
                response: 'error',
                message: "알 수 없는 에러 : "+error
            }
            sendMessage(socket, 'viewerResponse', message)
        }
    });

    //websocket stop 응답 처리 리스너, webRTC peer와 미디어서버 인스턴스, recorder 연결을 정리함
    socket.on('stop', (data) => {
        console.log(data)
        stop(data.streamUUID);
    });

    //websocket onIceCandidate 응답 처리 리스너, 클라이언트에서 전송한 ICE Candidate 후보군을 서버에 추가
    socket.on('onIceCandidate', (data) => {
        onIceCandidate(data.streamUUID, data.candidate);
    });
});


//쿠렌토 미디어서버 인스턴스를 생성하는 함수(싱글톤)
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

//쿠렌토 미디어 서버에서 미디어 트랜스코딩 인스턴스를 시작하는 함수
function startViewer(streamUUID, socket, sdpOffer, rtspUri, disasterNumber, carNumber, streamingName, callback) {

    //ICE Candidate 후보군 정리
    clearCandidatesQueue(streamUUID);

    //쿠렌토 미디어서버 인스턴스 생성
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            stop(streamUUID);
            return callback(error);
        }

        //MediaPipeline 생성
        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                stop(streamUUID);
                return callback(error);
            }

            //PlayerEndpoint 생성
            pipeline.create('PlayerEndpoint', {uri: rtspUri}, function(error, player) {
                if (error) {
                    stop(streamUUID);
                    return callback(error);
                }

                //WebRtcEndpoint 생성
                pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                    if (error) {
                        stop(streamUUID);
                        return callback(error);
                    }

                    //ICE Candidate 후보군 추가
                    if (candidatesQueue[streamUUID]) {
                        while (candidatesQueue[streamUUID].length) {
                            var candidate = candidatesQueue[streamUUID].shift();
                            webRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    //ICE Candidate 후보군 탐색 완료 리스너, 클라이언트에 후보군을 전송함
                    webRtcEndpoint.on('IceCandidateFound', async function(event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        const message = {
                            candidate: candidate,
                            streamUUID : streamUUID
                        }
                        sendMessage(socket, 'iceCandidate', message)
                    });

                    //영상을 녹화하며, 저장하기위한 디렉토리 설정
                    const recordUri = `file:///recorders/${getFormattedDate()}_${streamingName}_${disasterNumber}_${carNumber}_${streamUUID}.webm`;

                    //RecorderEndpoint 생성
                    pipeline.create('RecorderEndpoint', {uri: recordUri, mediaProfile: 'WEBM_VIDEO_ONLY'}, function(error, recorder) {
                        if (error) {
                            stop(streamUUID);
                            return callback(error);
                        }

                        //viewers 객체에 webRtcEndpoint, socket, recorder 할당
                        viewers[streamUUID] = {
                            webRtcEndpoint: webRtcEndpoint,
                            socket: socket,
                            recorder: recorder
                        };

                        //PlayerEndpoint에 recorderEndpoint 연결
                        player.connect(recorder, function(error) {
                            if (error) {
                                stop(streamUUID);
                                return callback(error);
                            }
                        });

                        //영상의 네트워크 전송 대역폭 설정
                        webRtcEndpoint.setMaxVideoSendBandwidth(2000);
                        webRtcEndpoint.setMinVideoSendBandwidth(500);

                        //영상의 네트워크 수신 대역폭 설정
                        webRtcEndpoint.setMaxVideoRecvBandwidth(2000);
                        webRtcEndpoint.setMinVideoRecvBandwidth(500);

                        //영상 녹화 시작 이벤트 리스너
                        recorder.on("Recording", function(event){
                            console.log("Recording",event)
                        })

                        //영상 녹화 일시정지 이벤트 리스너
                        recorder.on("Paused", function(event){
                            console.log("Paused",event)
                        })

                        //영상 녹화 중지 이벤트 리스너
                        recorder.on("Stopped", function(event){
                            console.log("Paused",event)
                        })

                        //영상의 변환이 완료되어 상태값이 변경될 때 동작하는 리스너
                        webRtcEndpoint.on("MediaStateChanged", function(event) {
                            //console.log("MediaStateChanged",event)
                            if ((event.oldState !== event.newState) && (event.newState === 'CONNECTED')) {
                                recorder.record(function(error) {
                                    if (error) {
                                        stop(streamUUID);
                                        return callback(error);
                                    }
                                });
                            }
                        });

                        //processOffer 생성 함수
                        webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                            if (error) {
                                stop(streamUUID);
                                return callback(error);
                            }

                            //ICE Candidate 후보군 수집 리스너
                            webRtcEndpoint.gatherCandidates(function(error) {
                                if (error) {
                                    stop(streamUUID);
                                    return callback(error);
                                }

                                //PlayerEndpoint에 webRtcEndpoint 연결
                                player.connect(webRtcEndpoint, function(error) {
                                    if (error) {
                                        stop(streamUUID);
                                        return callback(error);
                                    }
    
                                    //영상 재생 시작
                                    player.play(function(error) {
                                        if (error) {
                                            stop(streamUUID);
                                            return callback(error);
                                        }
    
                                        callback(null, sdpAnswer);
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

//ICE Candidate 후보군 정리 함수
function clearCandidatesQueue(streamUUID) {
  if (candidatesQueue[streamUUID]) {
    delete candidatesQueue[streamUUID];
  }
}

//영상변환 중지 함수 webRTC peer와 미디어서버 인스턴스, recorder 연결을 정리
function stop(streamUUID) {
    console.log("Stopping recorder for session:", streamUUID);
    if (viewers[streamUUID]) {
        viewers[streamUUID].recorder?.stop();
        viewers[streamUUID].recorder?.release();
        viewers[streamUUID].webRtcEndpoint?.release();
        delete viewers[streamUUID];
    }

    clearCandidatesQueue(streamUUID);

    if (viewers.length < 1) {
        console.log('Closing kurento client');
        kurentoClient?.close();
        kurentoClient = null;
    }
}

//클라이언트에서 전송한 ICE Candidate 후보군을 서버에 추가하는 함수
function onIceCandidate(streamUUID, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (viewers[streamUUID] && viewers[streamUUID].webRtcEndpoint) {
        //console.info('Sending viewer candidate');
        viewers[streamUUID].webRtcEndpoint.addIceCandidate(candidate);
    }else {
        //console.info('Queueing candidate');
        if (!candidatesQueue[streamUUID]) {
            candidatesQueue[streamUUID] = [];
        }
        candidatesQueue[streamUUID].push(candidate);
    }
}

//현재 날짜를 특정 포맷으로 변환하는 함수(yyyy_mm_dd-HH-MM-ss)
function getFormattedDate() {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0'); // 1~12
    const day = String(currentDate.getDate()).padStart(2, '0'); // 1~31

    const hours = String(currentDate.getHours()).padStart(2, '0');
    const minutes = String(currentDate.getMinutes()).padStart(2, '0');
    const seconds = String(currentDate.getSeconds()).padStart(2, '0');

    return `${year}_${month}_${day}-${hours}_${minutes}_${seconds}`;
}

//rtsp 아이피를 이용해 rtsp 영상의 엔드포인트 url을 생성하는 함수
function generateRtspEndpoint(rtspIp, id, password, cameraType){
    //세연은 /cam0_0가 엔드포인트에 붙음

    //특이 : 이노뎁의 김해동부-북부(펌프차_97거0144) (172.16.44.10) 인포스텍이랑 동일
    //chanel은 0이 기본값 stream은 1이 기본값
    //"rtsp://"+s.ip+":"+a.Port+"/cam/realmonitor?channel="+(s.channel+1)+"&subtype="+(s.stream-1)
    if(cameraType === "kedacom"){
        return `rtsp://${id}:${password}@${rtspIp}:${RTSP_PORT}/id=0`
    }else if(cameraType === "innodep"){
        return `rtsp://${id}:${password}@${rtspIp}:${RTSP_PORT}/id=0`
    }else if(cameraType === "infostech"){
        return ""
    }else if(cameraType === "seyeon"){
        return `rtsp://${id}:${password}@${rtspIp}:${RTSP_PORT}/cam0_0`
    }else{
        return `rtsp://${id}:${password}@${rtspIp}:${RTSP_PORT}/live/cctv001.stream`
    }
}
