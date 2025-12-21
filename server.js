// 麻将游戏服务器 - 使用 Node.js + Socket.io
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// 提供静态文件服务（index.html）
app.use(express.static(__dirname));

// 根路径返回 index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// 房间管理
const rooms = new Map(); // roomId -> { players: [], gameState: null, settings: {}, hostId: null }

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 创建房间
function createRoom(hostId, settings = {}) {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    players: [{ id: hostId, name: settings.playerName || '玩家1', isHost: true, seat: 0 }],
    gameState: null,
    hostId: hostId,  // 保存房主ID
    settings: {
      basePoints: settings.basePoints || 2000,
      perFanPoints: settings.perFanPoints || 1000,
      initialPoints: settings.initialPoints || 100000,
      ...settings
    },
    status: 'waiting', // waiting, playing, ended
    gameReady: false   // 游戏是否已初始化
  });
  return roomId;
}

// 加入房间
function joinRoom(roomId, playerId, playerName) {
  const room = rooms.get(roomId);
  if (!room) return { success: false, error: '房间不存在' };
  if (room.players.length >= 4) return { success: false, error: '房间已满' };
  if (room.status !== 'waiting') return { success: false, error: '游戏已开始' };
  
  const seat = room.players.length;
  const player = {
    id: playerId,
    name: playerName || `玩家${seat + 1}`,
    isHost: false,
    seat: seat
  };
  room.players.push(player);
  
  return { success: true, room, seat, player };
}

// 离开房间
function leaveRoom(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const leavingPlayer = room.players.find(p => p.id === playerId);
  const wasHost = leavingPlayer?.isHost;
  
  room.players = room.players.filter(p => p.id !== playerId);
  
  // 如果房间为空，删除房间
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    // 如果离开的是房主，转移房主
    if (wasHost && room.players.length > 0) {
      room.players[0].isHost = true;
      room.hostId = room.players[0].id;
    }
  }
}

// 广播房间状态
function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  io.to(roomId).emit('roomState', {
    players: room.players,
    status: room.status,
    settings: room.settings,
    hostId: room.hostId,
    gameReady: room.gameReady
  });
}

// Socket.io 连接处理
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);
  
  // 创建房间
  socket.on('createRoom', (settings, callback) => {
    const roomId = createRoom(socket.id, settings);
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, seat: 0, isHost: true });
    broadcastRoomState(roomId);
    if (callback) callback({ success: true, roomId });
  });
  
  // 加入房间
  socket.on('joinRoom', (data, callback) => {
    const { roomId, playerName } = data;
    const result = joinRoom(roomId, socket.id, playerName);
    
    if (result.success) {
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, seat: result.seat, isHost: false, player: result.player });
      broadcastRoomState(roomId);
    }
    
    if (callback) callback(result);
  });
  
  // 离开房间
  socket.on('leaveRoom', (roomId) => {
    leaveRoom(roomId, socket.id);
    socket.leave(roomId);
    broadcastRoomState(roomId);
  });
  
  // 开始游戏
  socket.on('startGame', (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) {
      if (socket.connected) {
        socket.emit('error', '需要至少2名玩家才能开始游戏');
      }
      return;
    }
    
    const host = room.players.find(p => p.id === socket.id);
    if (!host || !host.isHost) {
      if (socket.connected) {
        socket.emit('error', '只有房主可以开始游戏');
      }
      return;
    }
    
    room.status = 'playing';
    room.gameReady = false;  // 重置游戏准备状态
    
    console.log(`游戏开始 - 房间: ${roomId}, 玩家数: ${room.players.length}, 房主: ${room.hostId}`);
    
    io.to(roomId).emit('gameStarted', {
      players: room.players,
      settings: room.settings,
      status: 'playing',
      hostId: room.hostId
    });
  });
  
  // 获取房间状态
  socket.on('getRoomState', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (room) {
      if (callback) callback({ 
        success: true, 
        room: room,
        hostId: room.hostId,
        gameReady: room.gameReady
      });
    } else {
      if (callback) callback({ success: false, error: '房间不存在' });
    }
  });
  
  // 房主通知游戏已准备好
  socket.on('gameReady', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    if (!room) return;
    
    // 只有房主可以设置游戏准备状态
    if (room.hostId !== socket.id) return;
    
    room.gameReady = true;
    console.log(`游戏准备就绪 - 房间: ${roomId}`);
    
    // 通知所有玩家游戏已准备好
    io.to(roomId).emit('gameReadyNotify', {
      gameState: room.gameState
    });
  });
  
  // 同步游戏状态
  socket.on('gameStateUpdate', (data) => {
    const { roomId, gameState } = data;
    const room = rooms.get(roomId);
    if (!room) return;
    
    // 验证玩家身份
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    // 保存游戏状态
    room.gameState = gameState;
    
    // 广播给房间内其他玩家
    socket.to(roomId).emit('gameStateSync', {
      gameState: gameState,
      fromPlayer: player.seat,
      isHost: player.isHost
    });
  });
  
  // 玩家操作（出牌、碰、杠、吃、胡等）
  socket.on('playerAction', (data) => {
    const { roomId, action, params } = data;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    console.log(`玩家操作 - 房间: ${roomId}, 玩家: ${player.name}, 操作: ${action}`);
    
    // 广播操作给所有玩家（包括自己，用于确认）
    io.to(roomId).emit('actionBroadcast', {
      action: action,
      params: params,
      playerSeat: player.seat,
      playerName: player.name,
      isHost: player.isHost
    });
    
    // 【重要】如果房间有最新的游戏状态，立即广播给其他玩家，确保战况即时更新
    // 注意：游戏状态应该由客户端通过 gameStateUpdate 更新
    // 这里只是提醒其他玩家可能需要请求最新状态
    if (room.gameState) {
      // 延迟一点，等待客户端更新状态
      setTimeout(() => {
        socket.to(roomId).emit('gameStateSync', {
          gameState: room.gameState,
          fromPlayer: player.seat,
          isHost: player.isHost
        });
      }, 100);
    }
  });
  
  // 请求当前回合信息
  socket.on('requestTurnInfo', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) {
      if (callback) callback({ success: false, error: '游戏未开始' });
      return;
    }
    
    if (callback) callback({
      success: true,
      turn: room.gameState.turn,
      phase: room.gameState.phase,
      hostId: room.hostId
    });
  });
  
  // 断开连接
  socket.on('disconnect', () => {
    console.log('断开连接:', socket.id);
    // 从所有房间中移除该玩家
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.some(p => p.id === socket.id)) {
        leaveRoom(roomId, socket.id);
        broadcastRoomState(roomId);
        
        // 如果游戏正在进行，通知其他玩家
        if (room.status === 'playing') {
          io.to(roomId).emit('playerDisconnected', {
            playerId: socket.id,
            newHostId: room.hostId
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
// 监听所有网络接口，允许手机连接
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`本地访问: http://localhost:${PORT}`);
  console.log(`局域网访问: http://你的IP地址:${PORT}`);
  console.log(`\n获取本机IP地址:`);
  console.log(`Windows: ipconfig | findstr IPv4`);
  console.log(`Mac/Linux: ifconfig | grep inet`);
});
