const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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
// ПОДКЛЮЧЕНИЕ К SQLite
// ============================================================

const dbPath = path.join(__dirname, 'quiz.db');
const db = new sqlite3.Database(dbPath);

// ============================================================
// СОЗДАНИЕ ТАБЛИЦ
// ============================================================

db.serialize(() => {
  // 1. Квизы
  db.run(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomCode TEXT UNIQUE,
      title TEXT,
      description TEXT,
      questions TEXT,
      hostName TEXT,
      createdAt TEXT,
      isActive INTEGER DEFAULT 1
    )
  `);

  // 2. Результаты
  db.run(`
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quizId INTEGER,
      playerName TEXT,
      score INTEGER,
      total INTEGER,
      percentage INTEGER,
      createdAt TEXT,
      FOREIGN KEY (quizId) REFERENCES quizzes(id)
    )
  `);

  // 3. Активные комнаты (ВСЁ ХРАНИТСЯ ЗДЕСЬ!)
  db.run(`
    CREATE TABLE IF NOT EXISTS active_rooms (
      roomCode TEXT PRIMARY KEY,
      quizId INTEGER,
      hostSocketId TEXT,
      hostName TEXT,
      currentQuestion INTEGER DEFAULT 0,
      started INTEGER DEFAULT 0,
      finished INTEGER DEFAULT 0,
      questionStartTime INTEGER,
      totalQuestions INTEGER DEFAULT 0,
      players TEXT,  -- JSON
      quizData TEXT, -- JSON (вопросы)
      updatedAt TEXT,
      FOREIGN KEY (quizId) REFERENCES quizzes(id)
    )
  `);

  console.log('✅ База данных SQLite готова');
});

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function calculatePoints(isCorrect, timeSpent) {
  if (!isCorrect) return 0;
  let points = 100 - 1.5 * timeSpent;
  points = Math.round(Math.max(10, Math.min(100, points)));
  return points;
}

// ============================================================
// РАБОТА С БАЗОЙ ДАННЫХ
// ============================================================

function saveQuizToDB(roomCode, quiz, hostName) {
  return new Promise((resolve, reject) => {
    const questionsJson = JSON.stringify(quiz.questions);
    const createdAt = new Date().toISOString();
    
    db.run(
      `INSERT INTO quizzes (roomCode, title, description, questions, hostName, createdAt, isActive)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [roomCode, quiz.title, quiz.description || '', questionsJson, hostName, createdAt],
      function(err) {
        if (err) {
          console.error('❌ Ошибка сохранения квиза:', err);
          reject(err);
        } else {
          console.log(`💾 Квиз сохранён в БД (ID: ${this.lastID})`);
          resolve(this.lastID);
        }
      }
    );
  });
}
function saveRoomToDB(roomCode, room) {
  return new Promise((resolve, reject) => {
    const playersJson = JSON.stringify(Array.from(room.players.entries()));
    const quizDataJson = JSON.stringify(room.quiz);
    const updatedAt = new Date().toISOString();

    db.run(
      `INSERT OR REPLACE INTO active_rooms (
        roomCode, quizId, hostSocketId, hostName, currentQuestion,
        started, finished, questionStartTime, totalQuestions,
        players, quizData, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        roomCode,
        room.quizId || null,
        room.host,
        room.hostName,
        room.currentQuestion || 0,
        room.started ? 1 : 0,
        room.finished ? 1 : 0,
        room.questionStartTime || null,
        room.totalQuestions || 0,
        playersJson,
        quizDataJson,
        updatedAt
      ],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

function getRoomFromDB(roomCode) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM active_rooms WHERE roomCode = ?`,
      [roomCode],
      (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          // Восстанавливаем объект комнаты
          const playersMap = new Map(JSON.parse(row.players));
          const quiz = JSON.parse(row.quizData);
          
          const room = {
            host: row.hostSocketId,
            hostName: row.hostName,
            players: playersMap,
            quiz: quiz,
            currentQuestion: row.currentQuestion,
            started: row.started === 1,
            finished: row.finished === 1,
            questionStartTime: row.questionStartTime,
            totalQuestions: row.totalQuestions,
            quizId: row.quizId
          };
          resolve(room);
        }
      }
    );
  });
}

function deleteRoomFromDB(roomCode) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM active_rooms WHERE roomCode = ?`,
      [roomCode],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

function saveResultToDB(quizId, playerName, score, total, percentage) {
  const createdAt = new Date().toISOString();
  
  db.run(
    `INSERT INTO results (quizId, playerName, score, total, percentage, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [quizId, playerName, score, total, percentage, createdAt],
    function(err) {
      if (err) {
        console.error('Ошибка сохранения результата:', err);
      } else {
        console.log(`Результат ${playerName} сохранён в БД`);
      }
    }
  );
}

function getQuizIdByRoomCode(roomCode) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM quizzes WHERE roomCode = ?`,
      [roomCode],
      (err, row) => {
        if (err) reject(err);
        resolve(row ? row.id : null);
      }
    );
  });
}

// ============================================================
// ЗАГРУЗКА ВСЕХ АКТИВНЫХ КОМНАТ ПРИ СТАРТЕ
// ============================================================

const rooms = new Map();

async function loadAllRooms() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT roomCode FROM active_rooms`, async (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      for (const row of rows) {
        try {
          const room = await getRoomFromDB(row.roomCode);
          if (room) {
            rooms.set(row.roomCode, room);
            console.log(`Загружена комната: ${row.roomCode}`);
          }
        } catch (e) {
          console.error(`Ошибка загрузки комнаты ${row.roomCode}:`, e);
        }
      }
      resolve();
    });
  });
}

// ============================================================
// REST API (для просмотра данных)
// ============================================================

app.get('/api/quizzes', (req, res) => {
  db.all(`SELECT * FROM quizzes ORDER BY createdAt DESC`, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

app.get('/api/quizzes/:roomCode/results', (req, res) => {
  const { roomCode } = req.params;
  
  db.get(`SELECT id FROM quizzes WHERE roomCode = ?`, [roomCode], (err, quiz) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!quiz) {
      res.status(404).json({ error: 'Квиз не найден' });
      return;
    }

    db.all(
      `SELECT * FROM results WHERE quizId = ? ORDER BY percentage DESC`,
      [quiz.id],
      (err, rows) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json(rows);
      }
    );
  });
});

app.get('/api/rooms', (req, res) => {
  const activeRooms = Array.from(rooms.keys());
  res.json({ rooms: activeRooms, count: activeRooms.length });
});

// ============================================================
// WEBSOCKET
// ============================================================

io.on('connection', (socket) => {
  console.log('Клиент подключился:', socket.id);

  // ============================================================
  // СОЗДАНИЕ КОМНАТЫ
  // ============================================================

  socket.on('create-room', async ({ playerName, quiz }) => {
    try {
      const roomCode = generateRoomCode();

      // 1. Сохраняем квиз в БД
      const quizId = await saveQuizToDB(roomCode, quiz, playerName);

      // 2. Создаём комнату
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
        quizId: quizId
      };

      room.players.set(socket.id, {
        name: playerName,
        score: 0,
        answers: []
      });

      // 3. Сохраняем комнату в БД
      await saveRoomToDB(roomCode, room);

      // 4. Добавляем в память (для быстрого доступа)
      rooms.set(roomCode, room);

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.isHost = true;

      console.log(`Комната создана: ${roomCode} (хост: ${playerName})`);

      socket.emit('room-created', {
        roomCode,
        quiz,
        hostName: playerName
      });

      io.to(roomCode).emit('players-update', {
        players: Array.from(room.players.values()).map(p => p.name)
      });

    } catch (error) {
      console.error('Ошибка создания комнаты:', error);
      socket.emit('error', { message: 'Ошибка создания комнаты' });
    }
  });

  // ============================================================
  // ПРИСОЕДИНЕНИЕ К КОМНАТЕ
  // ============================================================

  socket.on('join-room', async ({ roomCode, playerName }) => {
    try {
      // 1. Загружаем комнату из БД (или из памяти)
      let room = rooms.get(roomCode);
      
      if (!room) {
        room = await getRoomFromDB(roomCode);
        if (!room) {
          socket.emit('error', { message: 'Комната не найдена' });
          return;
        }
        rooms.set(roomCode, room);
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

      // 2. Добавляем игрока
      room.players.set(socket.id, {
        name: playerName,
        score: 0,
        answers: []
      });

      // 3. Сохраняем в БД
      await saveRoomToDB(roomCode, room);

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.isHost = false;

      console.log(`${playerName} присоединился к комнате ${roomCode}`);

      socket.emit('room-joined', {
        roomCode,
        quiz: room.quiz,
        players: Array.from(room.players.values()).map(p => p.name)
      });

      io.to(roomCode).emit('players-update', {
        players: Array.from(room.players.values()).map(p => p.name)
      });

    } catch (error) {
      console.error('Ошибка присоединения:', error);
      socket.emit('error', { message: 'Ошибка присоединения' });
    }
  });

  // ============================================================
  // ВОССТАНОВЛЕНИЕ ПОСЛЕ ОБНОВЛЕНИЯ СТРАНИЦЫ
  // ============================================================

  socket.on('reconnect-room', async ({ roomCode, playerName, isHost }) => {
    try {
      let room = rooms.get(roomCode);
      
      if (!room) {
        room = await getRoomFromDB(roomCode);
        if (!room) {
          socket.emit('error', { message: 'Комната не найдена' });
          return;
        }
        rooms.set(roomCode, room);
      }

      // Проверяем, есть ли уже такой игрок
      let existingPlayer = null;
      let existingPlayerId = null;
      for (const [id, player] of room.players) {
        if (player.name === playerName) {
          existingPlayer = player;
          existingPlayerId = id;
          break;
        }
      }

      if (existingPlayer && existingPlayerId !== socket.id) {
        room.players.delete(existingPlayerId);
      }

      room.players.set(socket.id, {
        name: playerName,
        score: existingPlayer?.score || 0,
        answers: existingPlayer?.answers || []
      });

      if (isHost) {
        room.host = socket.id;
      }

      await saveRoomToDB(roomCode, room);

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.isHost = isHost || false;

      console.log(`${playerName} восстановил подключение к комнате ${roomCode}`);

      socket.emit('room-reconnected', {
        roomCode,
        quiz: room.quiz,
        players: Array.from(room.players.values()).map(p => p.name),
        isHost: isHost || false,
        currentQuestion: room.currentQuestion,
        started: room.started,
        finished: room.finished
      });

      io.to(roomCode).emit('players-update', {
        players: Array.from(room.players.values()).map(p => p.name)
      });

    } catch (error) {
      console.error('Ошибка восстановления:', error);
      socket.emit('error', { message: 'Ошибка восстановления' });
    }
  });

  // ============================================================
  // СТАРТ КВИЗА
  // ============================================================

  socket.on('start-quiz', async ({ roomCode }) => {
    try {
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

      await saveRoomToDB(roomCode, room);

      console.log(`Квиз стартовал в комнате ${roomCode}`);

      io.to(roomCode).emit('quiz-started', {
        totalQuestions: room.totalQuestions
      });

      sendQuestion(roomCode);

    } catch (error) {
      console.error('Ошибка старта квиза:', error);
      socket.emit('error', { message: 'Ошибка старта квиза' });
    }
  });

  // ============================================================
  // ОТПРАВКА ВОПРОСА
  // ============================================================

  async function sendQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.finished) return;

    const idx = room.currentQuestion;
    const questions = room.quiz.questions;

    if (idx >= questions.length) {
      await finishQuiz(roomCode);
      return;
    }

    const question = questions[idx];
    room.questionStartTime = Date.now();

    let imageData = question.image || null;
    if (imageData && imageData.length > 2000000) {
      imageData = null;
      console.log('Картинка слишком большая, пропущена');
    }

    await saveRoomToDB(roomCode, room);

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

    setTimeout(async () => {
      const currentRoom = rooms.get(roomCode);
      if (currentRoom && !currentRoom.finished) {
        const currentQuestion = currentRoom.quiz.questions[idx];
        io.to(roomCode).emit('timeout', {
          correctAnswers: currentQuestion.correct
        });

        setTimeout(async () => {
          const roomAfterTimeout = rooms.get(roomCode);
          if (roomAfterTimeout && !roomAfterTimeout.finished) {
            await nextQuestion(roomCode);
          }
        }, 3000);
      }
    }, 30000);
  }

  // ============================================================
  // СЛЕДУЮЩИЙ ВОПРОС
  // ============================================================

  async function nextQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.finished) return;

    room.currentQuestion++;
    await saveRoomToDB(roomCode, room);
    await sendQuestion(roomCode);
  }

  // ============================================================
  // ПРИЁМ ОТВЕТА
  // ============================================================

  socket.on('submit-answer', async ({ roomCode, questionIndex, selected }) => {
    try {
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

      await saveRoomToDB(roomCode, room);

      console.log(`${player.name} ответил на вопрос ${questionIndex + 1}: ${isCorrect ? '✅' : '❌'} (+${points} очков)`);

      socket.emit('answer-result', {
        isCorrect,
        points: isCorrect ? points : 0,
        correctAnswers: question.correct
      });

    } catch (error) {
      console.error('❌ Ошибка приёма ответа:', error);
      socket.emit('error', { message: 'Ошибка приёма ответа' });
    }
  });

  // ============================================================
  // СЛЕДУЮЩИЙ ВОПРОС (от организатора)
  // ============================================================

  socket.on('next-question', async ({ roomCode }) => {
    try {
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

      await nextQuestion(roomCode);

    } catch (error) {
      console.error('❌ Ошибка переключения вопроса:', error);
      socket.emit('error', { message: 'Ошибка переключения вопроса' });
    }
  });

  // ============================================================
  // ЗАВЕРШЕНИЕ КВИЗА
  // ============================================================

  async function finishQuiz(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.finished) return;

    room.finished = true;

    const leaderboard = [];
    const hostId = room.host;

    const quizId = await getQuizIdByRoomCode(roomCode);

    for (const [id, player] of room.players) {
      if (id === hostId) continue;

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

      if (quizId) {
        saveResultToDB(quizId, player.name, player.score, maxPossibleScore, percentage);
      }
    }

    leaderboard.sort((a, b) => b.score - a.score);

    await saveRoomToDB(roomCode, room);

    console.log(`Квиз завершён в комнате ${roomCode}`);
    console.log('Результаты игроков:', leaderboard);

    io.to(roomCode).emit('quiz-finished', {
      leaderboard
    });

    // Удаляем комнату через 5 минут
    setTimeout(async () => {
      if (rooms.has(roomCode)) {
        rooms.delete(roomCode);
        await deleteRoomFromDB(roomCode);
        console.log(`Комната ${roomCode} удалена из БД`);
      }
    }, 5 * 60 * 1000);
  }

  // ============================================================
  // ВЫХОД ИЗ КОМНАТЫ
  // ============================================================

  socket.on('leave-room', async ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;

      const player = room.players.get(socket.id);
      if (player) {
        console.log(`${player.name} покинул комнату ${roomCode}`);
      }

      room.players.delete(socket.id);

      if (socket.id === room.host) {
        console.log(`Хост покинул комнату ${roomCode}, удаляем`);
        rooms.delete(roomCode);
        await deleteRoomFromDB(roomCode);
        io.to(roomCode).emit('room-closed', { message: 'Организатор покинул комнату' });
        return;
      }

      await saveRoomToDB(roomCode, room);
      socket.leave(roomCode);
      socket.roomCode = null;

      io.to(roomCode).emit('players-update', {
        players: Array.from(room.players.values()).map(p => p.name)
      });

    } catch (error) {
      console.error('Ошибка выхода из комнаты:', error);
    }
  });

  // ============================================================
  // ОТКЛЮЧЕНИЕ
  // ============================================================

  socket.on('disconnect', async () => {
    console.log('Клиент отключился:', socket.id);

    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      console.log(`${player.name} отключился от комнаты ${roomCode}`);
    }

    room.players.delete(socket.id);

    if (socket.id === room.host) {
      console.log(`Хост отключился, удаляем комнату ${roomCode}`);
      rooms.delete(roomCode);
      await deleteRoomFromDB(roomCode);
      io.to(roomCode).emit('room-closed', { message: 'Организатор покинул комнату' });
      return;
    }

    await saveRoomToDB(roomCode, room);
    io.to(roomCode).emit('players-update', {
      players: Array.from(room.players.values()).map(p => p.name)
    });
  });
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

const PORT = 5000;

// Загружаем все активные комнаты из БД, потом запускаем сервер
loadAllRooms()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
      console.log(`WebSocket: ws://localhost:${PORT}`);
      console.log(`База данных: ${dbPath}`);
      console.log(`Активных комнат в БД: ${rooms.size}`);
    });
  })
  .catch((err) => {
    console.error('Ошибка загрузки комнат:', err);
    process.exit(1);
  });