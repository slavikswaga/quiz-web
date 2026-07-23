const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// ============================================================
// ХРАНИЛИЩЕ КОМНАТ
// ============================================================

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ============================================================
// ПОДСЧЁТ ОЧКОВ
// ============================================================

function calculatePoints(isCorrect, timeSpent) {
  if (!isCorrect) return 0;
  let points = 100 - 1.5 * timeSpent;
  points = Math.round(Math.max(10, Math.min(100, points)));
  return points;
}

// ============================================================
// WEBSOCKET
// ============================================================

io.on('connection', (socket) => {
  console.log('🟢 Клиент подключился:', socket.id);

  // ============================================================
  // СОЗДАНИЕ КОМНАТЫ
  // ============================================================

  socket.on('create-room', ({ playerName, quiz }) => {
    const roomCode = generateRoomCode();

    const room = {
      host: socket.id,
      hostName: playerName,
      players: new Map(),
      quiz: quiz,
      currentQuestion: 0,
      started: false,
      finished: false,
      questionStartTime: null,
      totalQuestions: quiz.questions.length,
      playerScores: new Map()
    };

    room.players.set(socket.id, {
      name: playerName,
      score: 0,
      answers: []
    });

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    console.log(`🏠 Комната создана: ${roomCode} (хост: ${playerName})`);

    socket.emit('room-created', {
      roomCode,
      quiz,
      hostName: playerName
    });

    io.to(roomCode).emit('players-update', {
      players: Array.from(room.players.values()).map(p => p.name)
    });
  });

  // ============================================================
  // ПРИСОЕДИНЕНИЕ К КОМНАТЕ
  // ============================================================

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (room.started) {
      socket.emit('error', { message: 'Квиз уже начался' });
      return;
    }

    if (room.finished) {
      socket.emit('error', { message: 'Квиз уже завершён' });
      return;
    }

    if (room.players.has(socket.id)) {
      socket.emit('error', { message: 'Вы уже в комнате' });
      return;
    }

    room.players.set(socket.id, {
      name: playerName,
      score: 0,
      answers: []
    });

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = false;

    console.log(`👤 ${playerName} присоединился к комнате ${roomCode}`);

    socket.emit('room-joined', {
      roomCode,
      quiz: room.quiz,
      players: Array.from(room.players.values()).map(p => p.name)
    });

    io.to(roomCode).emit('players-update', {
      players: Array.from(room.players.values()).map(p => p.name)
    });
  });

  // ============================================================
  // СТАРТ КВИЗА
  // ============================================================

  socket.on('start-quiz', ({ roomCode }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (socket.id !== room.host) {
      socket.emit('error', { message: 'Только организатор может начать квиз' });
      return;
    }

    if (room.started) {
      socket.emit('error', { message: 'Квиз уже начат' });
      return;
    }

    if (room.players.size < 2) {
      socket.emit('error', { message: 'Нужно минимум 2 игрока' });
      return;
    }

    room.started = true;
    room.currentQuestion = 0;
    room.questionStartTime = Date.now();

    for (const [id, player] of room.players) {
      player.score = 0;
      player.answers = [];
    }

    console.log(`🚀 Квиз стартовал в комнате ${roomCode}`);

    io.to(roomCode).emit('quiz-started', {
      totalQuestions: room.totalQuestions
    });

    sendQuestion(roomCode);
  });

  // ============================================================
  // ОТПРАВКА ВОПРОСА
  // ============================================================

  function sendQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.finished) return;

    const idx = room.currentQuestion;
    const questions = room.quiz.questions;

    if (idx >= questions.length) {
      finishQuiz(roomCode);
      return;
    }

    const question = questions[idx];
    room.questionStartTime = Date.now();

    // Ограничиваем размер картинки
    let imageData = question.image || null;
    if (imageData && imageData.length > 500000) {
      imageData = null;
      console.log('⚠️ Картинка слишком большая, пропущена');
    }

    io.to(roomCode).emit('new-question', {
      index: idx,
      total: questions.length,
      question: {
        text: question.text,
        options: question.options,
        multiple: question.multiple || false,
        image: imageData
      },
      timeLimit: 30
    });

    setTimeout(() => {
      const currentRoom = rooms.get(roomCode);
      if (currentRoom && !currentRoom.finished) {
        const currentQuestion = currentRoom.quiz.questions[idx];
        io.to(roomCode).emit('timeout', {
          correctAnswers: currentQuestion.correct
        });

        setTimeout(() => {
          const roomAfterTimeout = rooms.get(roomCode);
          if (roomAfterTimeout && !roomAfterTimeout.finished) {
            nextQuestion(roomCode);
          }
        }, 3000);
      }
    }, 30000);
  }

  // ============================================================
  // СЛЕДУЮЩИЙ ВОПРОС
  // ============================================================

  function nextQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.finished) return;

    room.currentQuestion++;
    sendQuestion(roomCode);
  }

  // ============================================================
  // ПРИЁМ ОТВЕТА
  // ============================================================

  socket.on('submit-answer', ({ roomCode, questionIndex, selected }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (room.finished) {
      socket.emit('error', { message: 'Квиз уже завершён' });
      return;
    }

    if (room.host === socket.id) {
      socket.emit('error', { message: 'Организатор не может отвечать' });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Игрок не найден' });
      return;
    }

    if (questionIndex !== room.currentQuestion) {
      socket.emit('error', { message: 'Время для этого вопроса истекло' });
      return;
    }

    player.answers[questionIndex] = selected;

    const question = room.quiz.questions[questionIndex];
    const isCorrect =
      selected.length === question.correct.length &&
      selected.every(a => question.correct.includes(a));

    const timeSpent = Math.min(30, Math.floor((Date.now() - room.questionStartTime) / 1000));
    const points = calculatePoints(isCorrect, timeSpent);

    if (isCorrect) {
      player.score += points;
    }

    console.log(`📝 ${player.name} ответил на вопрос ${questionIndex + 1}: ${isCorrect ? '✅' : '❌'} (+${points} очков)`);

    socket.emit('answer-result', {
      isCorrect,
      points: isCorrect ? points : 0,
      correctAnswers: question.correct
    });
  });

  // ============================================================
  // СЛЕДУЮЩИЙ ВОПРОС (от организатора)
  // ============================================================

  socket.on('next-question', ({ roomCode }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    if (socket.id !== room.host) {
      socket.emit('error', { message: 'Только организатор может переключать вопросы' });
      return;
    }

    if (room.finished) return;

    nextQuestion(roomCode);
  });

  // ============================================================
  // ЗАВЕРШЕНИЕ КВИЗА (БЕЗ ОРГАНИЗАТОРА)
  // ============================================================

  function finishQuiz(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.finished) return;

    room.finished = true;

    // Собираем результаты ТОЛЬКО ДЛЯ ИГРОКОВ
    const leaderboard = [];
    const hostId = room.host;
    
    for (const [id, player] of room.players) {
      if (id === hostId) continue; // ПРОПУСКАЕМ ОРГАНИЗАТОРА
      
      const totalQuestions = room.totalQuestions;
      const maxPossibleScore = totalQuestions * 100;
      const percentage = maxPossibleScore > 0
        ? Math.round((player.score / maxPossibleScore) * 100)
        : 0;

      leaderboard.push({
        name: player.name,
        score: player.score,
        total: maxPossibleScore,
        percentage: percentage
      });
    }

    leaderboard.sort((a, b) => b.score - a.score);

    console.log(`🏆 Квиз завершён в комнате ${roomCode}`);
    console.log('📊 Результаты игроков:', leaderboard);

    io.to(roomCode).emit('quiz-finished', {
      leaderboard
    });

    setTimeout(() => {
      if (rooms.has(roomCode)) {
        rooms.delete(roomCode);
        console.log(`🗑️ Комната ${roomCode} удалена`);
      }
    }, 5 * 60 * 1000);
  }

  // ============================================================
  // ВЫХОД ИЗ КОМНАТЫ
  // ============================================================

  socket.on('leave-room', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      console.log(`🔴 ${player.name} покинул комнату ${roomCode}`);
    }

    room.players.delete(socket.id);
    socket.leave(roomCode);
    socket.roomCode = null;

    if (socket.id === room.host) {
      console.log(`🏚️ Хост покинул комнату ${roomCode}, удаляем`);
      rooms.delete(roomCode);
      io.to(roomCode).emit('room-closed', { message: 'Организатор покинул комнату' });
      return;
    }

    io.to(roomCode).emit('players-update', {
      players: Array.from(room.players.values()).map(p => p.name)
    });
  });

  // ============================================================
  // ОТКЛЮЧЕНИЕ
  // ============================================================

  socket.on('disconnect', () => {
    console.log('🔴 Клиент отключился:', socket.id);

    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      console.log(`🔴 ${player.name} отключился от комнаты ${roomCode}`);
    }

    room.players.delete(socket.id);

    if (socket.id === room.host) {
      console.log(`🏚️ Хост отключился, удаляем комнату ${roomCode}`);
      rooms.delete(roomCode);
      io.to(roomCode).emit('room-closed', { message: 'Организатор покинул комнату' });
      return;
    }

    io.to(roomCode).emit('players-update', {
      players: Array.from(room.players.values()).map(p => p.name)
    });
  });
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 REST API: http://localhost:${PORT}`);
});