import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

function App() {
  // ============================================================
  // СОСТОЯНИЯ
  // ============================================================

  const [screen, setScreen] = useState('menu');
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [quiz, setQuiz] = useState(null);
  const [players, setPlayers] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState([]);
  const [score, setScore] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);
  const [isGameActive, setIsGameActive] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  // Состояние для создания квиза
  const [quizTitle, setQuizTitle] = useState('Мой супер квиз');
  const [quizDescription, setQuizDescription] = useState('');
  const [questions, setQuestions] = useState([
    {
      text: 'Сколько будет 2 + 2?',
      options: ['3', '4', '5', '6'],
      correct: [1],
      multiple: false,
      image: null
    },
    {
      text: 'Какие языки программирования существуют?',
      options: ['JavaScript', 'Python', 'Java', 'HTML'],
      correct: [0, 1, 2],
      multiple: true,
      image: null
    }
  ]);

  // ============================================================
  // ТАЙМЕР (только для игроков)
  // ============================================================

  useEffect(() => {
    let interval = null;

    if (screen === 'play' && !isHost && timeLeft > 0 && !showAnswer) {
      interval = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            clearInterval(interval);
            if (selectedAnswers.length > 0) {
              socket.emit('submit-answer', {
                roomCode,
                questionIndex: questionIndex,
                selected: selectedAnswers
              });
            } else {
              socket.emit('submit-answer', {
                roomCode,
                questionIndex: questionIndex,
                selected: []
              });
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [screen, isHost, timeLeft, showAnswer, selectedAnswers, socket, roomCode, questionIndex]);

  // ============================================================
  // ПОДКЛЮЧЕНИЕ WEBSOCKET
  // ============================================================

  useEffect(() => {
    const newSocket = io('http://localhost:5000');
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('🟢 Подключено к серверу');
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('🔴 Отключено от сервера');
      setIsConnected(false);
    });

    newSocket.on('room-created', (data) => {
      setRoomCode(data.roomCode);
      setQuiz(data.quiz);
      setPlayers([data.hostName]);
      setIsHost(true);
      setScreen('room');
    });

    newSocket.on('room-joined', (data) => {
      setQuiz(data.quiz);
      setPlayers(data.players);
      setRoomCode(data.roomCode);
      setIsHost(false);
      setScreen('room');
    });

    newSocket.on('players-update', (data) => {
      setPlayers(data.players);
    });

    newSocket.on('quiz-started', (data) => {
      setTotalQuestions(data.totalQuestions);
      setQuestionIndex(0);
      setIsGameActive(true);
      setScore(0);
      setSelectedAnswers([]);
      setShowAnswer(false);
      setScreen('play');
    });

    newSocket.on('new-question', (data) => {
      setCurrentQuestion(data.question);
      setQuestionIndex(data.index);
      setTotalQuestions(data.total);
      setTimeLeft(data.timeLimit || 30);
      setSelectedAnswers([]);
      setShowAnswer(false);
    });

    newSocket.on('answer-result', (data) => {
      setShowAnswer(true);
      if (data.isCorrect) {
        setScore(prev => prev + data.points);
      }
      setCurrentQuestion(prev => ({
        ...prev,
        correct: data.correctAnswers
      }));
    });

    newSocket.on('timeout', (data) => {
      setShowAnswer(true);
      setCurrentQuestion(prev => ({
        ...prev,
        correct: data.correctAnswers
      }));
    });

    newSocket.on('quiz-finished', (data) => {
      setLeaderboard(data.leaderboard);
      setScreen('results');
    });

    newSocket.on('error', (data) => {
      alert('❌ ' + data.message);
    });

    newSocket.on('room-closed', (data) => {
      alert('❌ ' + data.message);
      setScreen('menu');
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // ============================================================
  // ОТПРАВКА СОБЫТИЙ
  // ============================================================

  const createRoom = () => {
    if (!playerName.trim()) {
      alert('⚠️ Введите ваше имя!');
      return;
    }

    if (!quizTitle.trim()) {
      alert('⚠️ Введите название квиза!');
      return;
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text.trim()) {
        alert(`⚠️ Заполните текст вопроса ${i + 1}!`);
        return;
      }
      for (let j = 0; j < q.options.length; j++) {
        if (!q.options[j].trim()) {
          alert(`⚠️ Заполните вариант ${String.fromCharCode(65 + j)} в вопросе ${i + 1}!`);
          return;
        }
      }
      if (q.correct.length === 0) {
        alert(`⚠️ Выберите правильный ответ в вопросе ${i + 1}!`);
        return;
      }
    }

    // Обработка картинок — проверка размера
    const processedQuestions = questions.map(q => {
      let image = q.image || null;
      if (image && image.length > 200000) {
        alert(`⚠️ Картинка в вопросе "${q.text}" слишком большая. Максимум 200KB.`);
        image = null;
      }
      return {
        text: q.text,
        options: q.options,
        correct: q.correct,
        multiple: q.multiple || false,
        image: image
      };
    });

    const quizData = {
      title: quizTitle,
      description: quizDescription,
      questions: processedQuestions
    };

    socket.emit('create-room', {
      playerName,
      quiz: quizData
    });
  };

  const joinRoom = () => {
    if (!roomCode.trim()) {
      alert('⚠️ Введите код комнаты!');
      return;
    }

    if (!playerName.trim()) {
      alert('⚠️ Введите ваше имя!');
      return;
    }

    socket.emit('join-room', {
      roomCode: roomCode.trim().toUpperCase(),
      playerName
    });
  };

  const startQuiz = () => {
    socket.emit('start-quiz', { roomCode });
  };

  const handleSelectOption = (index) => {
    if (showAnswer || isHost) return;

    const q = currentQuestion;
    if (!q) return;

    if (q.multiple) {
      setSelectedAnswers(prev => {
        const idx = prev.indexOf(index);
        if (idx === -1) {
          return [...prev, index];
        } else {
          return prev.filter(i => i !== index);
        }
      });
    } else {
      setSelectedAnswers([index]);
    }
  };

  const submitAnswer = () => {
    if (showAnswer || isHost) return;
    if (selectedAnswers.length === 0) {
      alert('⚠️ Выберите ответ!');
      return;
    }

    socket.emit('submit-answer', {
      roomCode,
      questionIndex: questionIndex,
      selected: selectedAnswers
    });
  };

  const nextQuestion = () => {
    socket.emit('next-question', { roomCode });
  };

  const leaveRoom = () => {
    socket.emit('leave-room', { roomCode });
    setScreen('menu');
    setRoomCode('');
    setQuiz(null);
    setPlayers([]);
    setIsHost(false);
  };

  // ============================================================
  // UI ФУНКЦИИ ДЛЯ СОЗДАНИЯ КВИЗА
  // ============================================================

  const addQuestion = () => {
    setQuestions([
      ...questions,
      {
        text: '',
        options: ['', '', '', ''],
        correct: [0],
        multiple: false,
        image: null
      }
    ]);
  };

  const removeQuestion = (index) => {
    if (questions.length <= 1) {
      alert('❌ Должен быть хотя бы один вопрос!');
      return;
    }
    const newQuestions = [...questions];
    newQuestions.splice(index, 1);
    setQuestions(newQuestions);
  };

  const updateQuestion = (index, field, value) => {
    const newQuestions = [...questions];
    newQuestions[index][field] = value;
    setQuestions(newQuestions);
  };

  const updateOption = (qIndex, oIndex, value) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].options[oIndex] = value;
    setQuestions(newQuestions);
  };

  const toggleCorrectAnswer = (qIndex, oIndex) => {
    const newQuestions = [...questions];
    const q = newQuestions[qIndex];

    if (q.multiple) {
      const idx = q.correct.indexOf(oIndex);
      if (idx === -1) {
        q.correct.push(oIndex);
      } else {
        q.correct.splice(idx, 1);
      }
    } else {
      q.correct = [oIndex];
    }

    setQuestions(newQuestions);
  };

  const toggleMultiple = (qIndex) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].multiple = !newQuestions[qIndex].multiple;
    if (!newQuestions[qIndex].multiple) {
      newQuestions[qIndex].correct = [newQuestions[qIndex].correct[0] || 0];
    }
    setQuestions(newQuestions);
  };

  const handleImageUpload = (qIndex, e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Проверка размера файла (максимум 200KB)
    if (file.size > 200 * 1024) {
      alert('⚠️ Картинка слишком большая! Максимум 200KB.');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const newQuestions = [...questions];
      newQuestions[qIndex].image = event.target.result;
      setQuestions(newQuestions);
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (qIndex) => {
    const newQuestions = [...questions];
    newQuestions[qIndex].image = null;
    setQuestions(newQuestions);
  };

  // ============================================================
  // РЕНДЕРИНГ
  // ============================================================

  // МЕНЮ
  if (screen === 'menu') {
    return (
      <div className="app">
        <div className="container">
          <div className="card">
            <div className="header-brand">
              <h1>🎯 Квиз<span>Мастер</span></h1>
              <p className="subtitle">Создавайте квизы и играйте с друзьями!</p>
              {!isConnected && (
                <p style={{ color: '#e53e3e', fontSize: '14px', marginTop: '8px' }}>
                  ⚠️ Нет подключения к серверу
                </p>
              )}
            </div>

            <div className="form-group">
              <label>Ваше имя</label>
              <input
                type="text"
                placeholder="Введите ваше имя"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
              />
            </div>

            <div className="menu-buttons">
              <button
                className="btn-primary"
                onClick={() => {
                  if (!playerName.trim()) {
                    alert('⚠️ Введите ваше имя!');
                    return;
                  }
                  setScreen('create');
                }}
                disabled={!isConnected}
              >
                🏠 Создать комнату
              </button>

              <div className="divider">или</div>

              <button
                className="btn-secondary"
                onClick={() => {
                  if (!playerName.trim()) {
                    alert('⚠️ Введите ваше имя!');
                    return;
                  }
                  setScreen('join');
                }}
                disabled={!isConnected}
              >
                🔗 Присоединиться
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ПРИСОЕДИНИТЬСЯ
  if (screen === 'join') {
    return (
      <div className="app">
        <div className="container">
          <div className="card">
            <h2 style={{ marginBottom: '8px' }}>🔗 Присоединиться</h2>
            <p className="subtitle">Введите код комнаты</p>

            <div className="form-group" style={{ marginTop: '16px' }}>
              <label>Код комнаты</label>
              <input
                type="text"
                placeholder="Например: ABC123"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                maxLength={6}
                style={{ textTransform: 'uppercase', letterSpacing: '4px', fontSize: '24px', textAlign: 'center' }}
              />
            </div>

            <div className="form-group">
              <label>Ваше имя</label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
              />
            </div>

            <div className="menu-buttons" style={{ marginTop: '16px' }}>
              <button
                className="btn-primary"
                onClick={joinRoom}
                disabled={!isConnected}
              >
                🔗 Присоединиться
              </button>

              <button
                className="btn-secondary"
                onClick={() => setScreen('menu')}
              >
                ← Назад
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // СОЗДАНИЕ КВИЗА
  if (screen === 'create') {
    const letters = ['A', 'B', 'C', 'D'];

    return (
      <div className="app">
        <div className="container">
          <div className="card card-wide">
            <h2>📝 Создать квиз</h2>
            <p className="subtitle">Вы — организатор! Заполните вопросы</p>

            <div className="form-group" style={{ marginTop: '16px' }}>
              <label>Название квиза</label>
              <input
                type="text"
                value={quizTitle}
                onChange={(e) => setQuizTitle(e.target.value)}
                placeholder="Введите название"
              />
            </div>

            <div className="form-group">
              <label>Описание (необязательно)</label>
              <textarea
                value={quizDescription}
                onChange={(e) => setQuizDescription(e.target.value)}
                placeholder="Краткое описание"
                rows="2"
              />
            </div>

            <h3 style={{ marginTop: '20px', color: '#2d3748', fontSize: '18px' }}>
              Вопросы ({questions.length})
            </h3>

            {questions.map((q, qIndex) => (
              <div key={qIndex} className="question-block">
                <div className="flex-between">
                  <h4 style={{ fontSize: '15px', color: '#2d3748' }}>
                    Вопрос {qIndex + 1}
                  </h4>
                  <button
                    className="btn-danger"
                    onClick={() => removeQuestion(qIndex)}
                    title="Удалить вопрос"
                  >
                    ✕
                  </button>
                </div>

                <div className="form-group" style={{ marginTop: '8px' }}>
                  <input
                    type="text"
                    placeholder="Текст вопроса"
                    value={q.text}
                    onChange={(e) => updateQuestion(qIndex, 'text', e.target.value)}
                  />

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="btn-secondary btn-small" style={{ width: 'auto', padding: '6px 16px', fontSize: '13px', cursor: 'pointer' }}>
                      🖼️ Загрузить картинку (до 200KB)
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => handleImageUpload(qIndex, e)}
                        style={{ display: 'none' }}
                      />
                    </label>
                    {q.image && (
                      <button
                        className="btn-danger"
                        onClick={() => removeImage(qIndex)}
                        style={{ fontSize: '14px' }}
                      >
                        ✕ Удалить
                      </button>
                    )}
                  </div>

                  {q.image && (
                    <div style={{ marginTop: '6px' }}>
                      <img
                        src={q.image}
                        alt="Вопрос"
                        className="question-image-preview"
                      />
                    </div>
                  )}

                  <div className="flex-between" style={{ marginTop: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '600', color: '#4a5568' }}>Варианты ответов:</span>
                    <label style={{ fontSize: '13px', color: '#718096', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="checkbox"
                        checked={q.multiple}
                        onChange={() => toggleMultiple(qIndex)}
                      />
                      Множественный выбор
                    </label>
                  </div>

                  {q.options.map((opt, oIndex) => (
                    <div key={oIndex} className="options-row">
                      <span className="letter">{letters[oIndex]}.</span>
                      <input
                        type="text"
                        placeholder={`Вариант ${letters[oIndex]}`}
                        value={opt}
                        onChange={(e) => updateOption(qIndex, oIndex, e.target.value)}
                      />
                      <input
                        type={q.multiple ? 'checkbox' : 'radio'}
                        name={`correct_${qIndex}`}
                        checked={q.correct.includes(oIndex)}
                        onChange={() => toggleCorrectAnswer(qIndex, oIndex)}
                      />
                      <span style={{ fontSize: '12px', color: '#a0aec0', minWidth: '20px' }}>
                        {q.correct.includes(oIndex) ? '✅' : '✓'}
                      </span>
                    </div>
                  ))}

                  {q.multiple && (
                    <p style={{ fontSize: '12px', color: '#718096', marginTop: '4px' }}>
                      💡 Выбрано правильных ответов: {q.correct.length}
                    </p>
                  )}
                </div>
              </div>
            ))}

            <button
              className="btn-secondary btn-small"
              onClick={addQuestion}
              style={{ marginTop: '4px' }}
            >
              + Добавить вопрос
            </button>

            <div className="menu-buttons" style={{ marginTop: '20px' }}>
              <button
                className="btn-primary"
                onClick={createRoom}
                disabled={!isConnected}
              >
                🚀 Создать комнату и начать
              </button>

              <button
                className="btn-secondary"
                onClick={() => setScreen('menu')}
              >
                ← Назад
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // КОМНАТА
  if (screen === 'room') {
    let hostName = quiz?.host;

    if (!hostName) {
      if (isHost) {
        hostName = playerName;
      } else {
        hostName = players.length > 0 ? players[0] : 'Организатор';
      }
    }

    const allPlayers = players || [];
    const playersList = allPlayers.filter(name => name !== hostName);
    const amIHost = playerName === hostName || isHost;
    const amIPlayer = !amIHost && playersList.includes(playerName);

    return (
      <div className="app">
        <div className="container">
          <div className="card">
            <div className="room-header">
              <h2>🔵 Комната: {roomCode}</h2>
              <span className={`role-badge ${amIHost ? 'host' : 'player'}`}>
                {amIHost ? '👑 Организатор' : '👤 Участник'}
              </span>
            </div>

            {quiz && (
              <div style={{ marginBottom: '12px', padding: '12px', background: '#f7fafc', borderRadius: '10px' }}>
                <strong style={{ color: '#2d3748' }}>{quiz.title}</strong>
                {quiz.description && (
                  <p style={{ color: '#718096', fontSize: '14px', marginTop: '4px' }}>{quiz.description}</p>
                )}
                <p style={{ color: '#a0aec0', fontSize: '12px', marginTop: '4px' }}>
                  📝 {quiz.questions?.length || 0} вопросов
                </p>
              </div>
            )}

            <div style={{
              marginBottom: '12px',
              padding: '12px 16px',
              background: '#fff5f7',
              borderRadius: '10px',
              border: '2px solid #e94560'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>👑</span>
                <span style={{ fontWeight: '700', color: '#2d3748' }}>Организатор:</span>
                <span style={{ fontWeight: '600', color: '#e94560' }}>{hostName}</span>
                {amIHost && <span style={{ fontSize: '12px', color: '#718096' }}>(это вы)</span>}
              </div>
            </div>

            <div className="players-list">
              <h4>👥 Игроки ({playersList.length})</h4>
              {playersList.length > 0 ? (
                playersList.map((name, idx) => (
                  <span key={idx} className="player-badge">
                    🟢 {name}
                    {name === playerName && ' (вы)'}
                  </span>
                ))
              ) : (
                <p style={{ color: '#a0aec0', fontSize: '14px' }}>
                  ⏳ Ожидание игроков...
                </p>
              )}
            </div>

            {amIHost ? (
              <>
                <button
                  className="btn-primary"
                  onClick={startQuiz}
                  disabled={playersList.length < 1}
                >
                  🚀 Начать квиз {playersList.length < 1 && '(нет игроков)'}
                </button>
                <p style={{ color: '#718096', fontSize: '13px', marginTop: '8px', textAlign: 'center' }}>
                  👑 Вы организатор — вы зачитываете вопросы, но не отвечаете
                </p>
              </>
            ) : amIPlayer ? (
              <p style={{ color: '#a0aec0', marginTop: '16px', textAlign: 'center' }}>
                ⏳ Ожидайте начала квиза...
              </p>
            ) : (
              <p style={{ color: '#e53e3e', marginTop: '16px', textAlign: 'center' }}>
                ⚠️ Вы не в этой комнате
              </p>
            )}

            <button
              className="btn-secondary"
              onClick={leaveRoom}
              style={{ marginTop: '12px' }}
            >
              ← Выйти из комнаты
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ИГРА
  if (screen === 'play') {
    if (!currentQuestion) {
      return (
        <div className="app">
          <div className="container">
            <div className="card text-center">
              <h2>⏳ Загрузка вопроса...</h2>
            </div>
          </div>
        </div>
      );
    }

    const q = currentQuestion;
    const total = totalQuestions;
    const progress = ((questionIndex + 1) / total) * 100;
    const isLast = questionIndex === total - 1;
    const letters = ['A', 'B', 'C', 'D'];
    const correctAnswers = q.correct || [];

    return (
      <div className="app">
        <div className="container">
          <div className="card card-wide">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>

            <div className="question-header">
              <span className="counter">
                Вопрос {questionIndex + 1} из {total}
                {q.multiple && ' (множественный выбор)'}
                {isHost && ' 👑 для зачитывания'}
              </span>
              {!isHost && (
                <span className="timer" style={{ color: timeLeft <= 5 ? '#e53e3e' : '#2d3748' }}>
                  ⏱️ {timeLeft}с
                </span>
              )}
              {isHost && (
                <span style={{ color: '#718096', fontSize: '14px' }}>⏱️ Зачитайте вопрос</span>
              )}
            </div>

            <div className="question-text">{q.text}</div>

            {q.image && (
              <div style={{ marginBottom: '16px', textAlign: 'center' }}>
                <img
                  src={q.image}
                  alt="Иллюстрация к вопросу"
                  className="question-image"
                />
              </div>
            )}

            <div className="options-grid">
              {q.options.map((opt, idx) => {
                let className = 'option';

                if (isHost) {
                  className += ' disabled';
                } else if (showAnswer) {
                  if (correctAnswers.includes(idx)) {
                    className += ' correct';
                  } else if (selectedAnswers.includes(idx)) {
                    className += ' wrong';
                  } else {
                    className += ' disabled';
                  }
                } else if (selectedAnswers.includes(idx)) {
                  className += ' selected';
                }

                return (
                  <button
                    key={idx}
                    className={className}
                    onClick={() => handleSelectOption(idx)}
                    disabled={isHost || showAnswer}
                  >
                    <span className="letter">{letters[idx]}</span>
                    {opt}
                    {!isHost && showAnswer && correctAnswers.includes(idx) && ' ✅'}
                    {!isHost && showAnswer && selectedAnswers.includes(idx) && !correctAnswers.includes(idx) && ' ❌'}
                  </button>
                );
              })}
            </div>

            <div className="flex-between" style={{ marginBottom: '12px' }}>
              <span style={{ color: '#718096', fontSize: '14px' }}>
                {isHost ? '👑 Вы зачитываете вопрос' : `👤 ${playerName}`}
                {!isHost && q.multiple && ' • Выберите все подходящие варианты'}
              </span>
              {!isHost && (
                <span style={{ color: '#2d3748', fontWeight: '600' }}>
                  🏆 {score} очков
                </span>
              )}
            </div>

            {!isHost && !showAnswer && (
              <button
                className="btn-primary"
                onClick={submitAnswer}
                disabled={selectedAnswers.length === 0}
              >
                ✅ Ответить
              </button>
            )}

            {!isHost && showAnswer && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{
                  padding: '12px',
                  borderRadius: '10px',
                  background: selectedAnswers.length > 0 && selectedAnswers.every(a => correctAnswers.includes(a)) && selectedAnswers.length === correctAnswers.length ? '#f0fff4' : '#fff5f5',
                  border: `2px solid ${selectedAnswers.length > 0 && selectedAnswers.every(a => correctAnswers.includes(a)) && selectedAnswers.length === correctAnswers.length ? '#48bb78' : '#fc8181'}`,
                  textAlign: 'center',
                  fontWeight: '600',
                  color: selectedAnswers.length > 0 && selectedAnswers.every(a => correctAnswers.includes(a)) && selectedAnswers.length === correctAnswers.length ? '#38a169' : '#e53e3e'
                }}>
                  {selectedAnswers.length > 0 && selectedAnswers.every(a => correctAnswers.includes(a)) && selectedAnswers.length === correctAnswers.length
                    ? `✅ Правильно!`
                    : '❌ Неправильно'
                  }
                  {q.multiple && (
                    <div style={{ fontSize: '13px', fontWeight: '400', marginTop: '4px' }}>
                      Правильные ответы: {correctAnswers.map(i => q.options[i]).join(', ')}
                    </div>
                  )}
                </div>

                {!isLast && (
                  <p style={{ textAlign: 'center', color: '#718096', fontSize: '14px' }}>
                    ⏳ Ожидайте следующий вопрос...
                  </p>
                )}
              </div>
            )}

            {isHost && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                <p style={{ color: '#718096', fontSize: '14px', textAlign: 'center' }}>
                  👑 Вы организатор — зачитайте вопрос участникам
                </p>
                <button
                  className="btn-secondary"
                  onClick={nextQuestion}
                >
                  {isLast ? '🏁 Завершить квиз' : 'Следующий вопрос →'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // РЕЗУЛЬТАТЫ
  if (screen === 'results') {
    const totalQuestionsCount = quiz?.questions?.length || 0;
    const maxPossibleScore = totalQuestionsCount * 100;

    const hostName = quiz?.host || '';
    const filteredLeaderboard = leaderboard.filter(item => item.name !== hostName);

    const myResult = filteredLeaderboard.find(item => item.name === playerName);
    const myScore = myResult?.score || 0;
    const myPercentage = myResult?.percentage || 0;

    return (
      <div className="app">
        <div className="container">
          <div className="card">
            <h2 className="text-center">🎉 Квиз завершён!</h2>

            {!isHost && (
              <div className="result-display">
                <div className="big-score">
                  {myScore} <span>очков</span>
                </div>
                <div className={`result-percentage ${myPercentage >= 60 ? 'passed' : 'failed'}`}>
                  {myPercentage}% • {myPercentage >= 60 ? '✅ Отлично!' : '❌ Попробуйте ещё раз'}
                </div>
              </div>
            )}

            {isHost && (
              <div style={{ textAlign: 'center', padding: '16px 0', color: '#718096' }}>
                👑 Вы организатор — вот результаты игроков
              </div>
            )}

            <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '2px solid #e2e8f0' }}>
              <h3 style={{ textAlign: 'center', color: '#2d3748', marginBottom: '16px' }}>
                🏆 ЛИДЕРБОРД
              </h3>

              {filteredLeaderboard.length > 0 ? (
                filteredLeaderboard.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 16px',
                      background: item.name === playerName ? '#fff5f7' : '#f7fafc',
                      borderRadius: '10px',
                      marginBottom: '6px',
                      border: item.name === playerName ? '2px solid #e94560' : 'none'
                    }}
                  >
                    <span style={{
                      fontWeight: '700',
                      fontSize: '18px',
                      minWidth: '40px',
                      color: idx === 0 ? '#f6ad55' : idx === 1 ? '#a0aec0' : idx === 2 ? '#ed8936' : '#a0aec0'
                    }}>
                      {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                    </span>
                    <span style={{ flex: 1, fontWeight: '600' }}>
                      {item.name}
                    </span>
                    <span style={{ fontWeight: '700', color: '#2d3748' }}>
                      {item.score} очков
                    </span>
                    <span style={{ fontSize: '14px', color: '#718096' }}>
                      {item.percentage}%
                    </span>
                  </div>
                ))
              ) : (
                <p style={{ textAlign: 'center', color: '#a0aec0' }}>
                  Нет результатов
                </p>
              )}
            </div>

            <div className="menu-buttons" style={{ marginTop: '16px' }}>
              <button
                className="btn-primary"
                onClick={() => {
                  setScreen('menu');
                  setScore(0);
                  setSelectedAnswers([]);
                  setShowAnswer(false);
                  setIsGameActive(false);
                  setLeaderboard([]);
                }}
              >
                🏠 На главную
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default App;