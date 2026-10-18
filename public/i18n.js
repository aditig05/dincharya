// Hindi text for the interface. Keys are the English strings used in the code; anything missing
// here simply stays in English. {x} marks a value filled in at runtime.
window.DincharyaI18n = {
  cats: {
    work: 'काम', study: 'पढ़ाई', meal: 'खाना', break: 'ब्रेक', exercise: 'व्यायाम', sleep: 'नींद',
    commute: 'आना-जाना', chores: 'घर के काम', social: 'मिलना-जुलना', leisure: 'मनोरंजन', personal: 'निजी', other: 'अन्य',
  },
  hi: {
    // header, sign-in, install
    "Say what you're doing. Dincharya keeps your day.": 'बोलिए आप क्या कर रहे हैं, दिनचर्या आपका दिन संभालेगी।',
    'Put Dincharya on your home screen for one-tap logging and alerts.': 'दिनचर्या को होम स्क्रीन पर रखें, एक टैप में लॉग और अलर्ट के लिए।',
    Install: 'इंस्टॉल करें', 'Not now': 'अभी नहीं',
    'Your session ended. Please sign in again.': 'आपका सत्र खत्म हो गया। कृपया फिर से साइन इन करें।',
    'Synced': 'सिंक हो गया', 'Syncing…': 'सिंक हो रहा है…', 'Offline · saved here': 'ऑफ़लाइन · यहीं सेव है', 'Sync failed': 'सिंक नहीं हुआ', 'This device only': 'सिर्फ़ इस डिवाइस पर',

    // now card
    'Right now': 'अभी', 'Nothing running. What are you doing?': 'अभी कुछ नहीं चल रहा। आप क्या कर रहे हैं?',
    '{x} left': '{x} बाकी', 'Since {t}': '{t} से', 'Running for a long time. Forgot to stop it?': 'काफ़ी देर से चल रहा है। रोकना भूल गए?',
    '{x} is over': '{x} खत्म', 'Ended {d} ago at {t}.': '{d} पहले, {t} बजे खत्म हुआ।', 'Back to {x}': 'वापस {x}',
    '+10 min': '+10 मिनट', Done: 'हो गया', 'Break {x}': 'ब्रेक {x}',

    // say card
    Log: 'लॉग करें',
    'Tap the mic and say what you are doing, or ask about your days (“is hafte kitna padha?”). English, Hindi or a mix.': 'माइक दबाकर बोलिए आप क्या कर रहे हैं, या अपने दिनों के बारे में पूछिए (“इस हफ़्ते कितना पढ़ा?”)। हिंदी, अंग्रेज़ी या मिलाकर।',
    '“Break for 30 min” · “2 se 5 tak DSA kiya” · “Kal maine kya kiya?”': '“30 मिनट का ब्रेक” · “2 से 5 तक DSA किया” · “कल मैंने क्या किया?”',
    'Got it, writing it down…': 'ठीक है, लिख रहे हैं…', 'Listening… tap the mic again when done.': 'सुन रहे हैं… बोलकर माइक फिर दबाइए।',
    'Listening to that…': 'समझ रहे हैं…', 'Looking through your days…': 'आपके दिन देख रहे हैं…',
    'Say or type what you are doing.': 'बोलिए या लिखिए आप क्या कर रहे हैं।', 'Nothing is running right now.': 'अभी कुछ नहीं चल रहा।',

    // day + week
    Day: 'दिन', Week: 'हफ़्ता', Today: 'आज', Yesterday: 'कल', 'This week': 'यह हफ़्ता', 'Last week': 'पिछला हफ़्ता',
    '{d} logged': '{d} दर्ज', 'not logged · {d}': 'दर्ज नहीं · {d}', now: 'अभी', '● now': '● अभी', 'to {t}': '{t} तक',
    'Nothing logged on this day.': 'इस दिन कुछ दर्ज नहीं है।', '+ Add manually': '+ खुद जोड़ें', 'Summarise this day': 'इस दिन का सार',
    '{c} streak: {n} days': '{c}: लगातार {n} दिन', 'Nothing logged this week yet.': 'इस हफ़्ते अभी कुछ दर्ज नहीं है।',
    'Focused (work + study): ': 'फ़ोकस (काम + पढ़ाई): ', ' · about {d} a day on days you logged': ' · दर्ज किए दिनों में रोज़ लगभग {d}',
    'Breaks: ': 'ब्रेक: ', ' · average {d}': ' · औसत {d}', 'Exercise: ': 'व्यायाम: ', '{n} times': '{n} बार', ', {d} in total': ', कुल {d}',
    'Most focused day: ': 'सबसे ज़्यादा फ़ोकस वाला दिन: ', 'Sleep logged: ': 'दर्ज नींद: ',
    '{c} goal met on {n} of {d} days': '{c} का लक्ष्य {d} में से {n} दिन पूरा', 'Goal met': 'लक्ष्य पूरा',

    // toasts and dialogs
    'Logged {x}.': '{x} दर्ज किया।', 'Logged {n} activities.': '{n} गतिविधियाँ दर्ज कीं।', 'Stopped {x}.': '{x} रोका।', 'Undone.': 'वापस किया।', Undo: 'वापस',
    'Saved.': 'सेव हो गया।', 'Added {x}.': '{x} जोड़ा।', 'Deleted {x}.': '{x} हटाया।', '{x} extended to {t}.': '{x} अब {t} तक।',
    'Edit activity': 'गतिविधि बदलें', 'Add activity': 'गतिविधि जोड़ें',

    // nudges
    "You've been on a break for {d}. Ready to get back?": 'आप {d} से ब्रेक पर हैं। वापस चलें?',
    '{x} has been running for {d}. Finished?': '{x} {d} से चल रहा है। हो गया?',
    '{d} of {x} without a break. A 10-minute break?': 'बिना ब्रेक {d} {x}। 10 मिनट का ब्रेक लें?',
    'No lunch logged yet today. Eaten something?': 'आज अभी तक दोपहर का खाना दर्ज नहीं है। कुछ खाया?',
    'No dinner logged yet tonight.': 'आज रात का खाना अभी दर्ज नहीं है।',
    'Nothing logged since {t}. What have you been up to?': '{t} से कुछ दर्ज नहीं है। क्या कर रहे थे?',
    Dismiss: 'छोड़ें', 'Break 10m': 'ब्रेक 10 मिनट', 'Log lunch': 'खाना दर्ज करें', 'Log dinner': 'खाना दर्ज करें', 'Log it': 'दर्ज करें',

    // settings
    Settings: 'सेटिंग्स', 'App language': 'ऐप की भाषा', 'Reply language': 'जवाब की भाषा',
    'Speak replies out loud': 'जवाब बोलकर सुनाएँ', 'Alert me when a timed activity ends': 'समय वाली गतिविधि खत्म होने पर बताएँ',
    'Gentle nudges (long breaks, missed meals, long sessions)': 'हल्की याद दिलाना (लंबा ब्रेक, छूटा खाना, लंबा सत्र)',
    'Daily goals': 'रोज़ के लक्ष्य', 'Hours per day. Leave empty for no goal.': 'रोज़ के घंटे। लक्ष्य न हो तो खाली छोड़ें।',
    'Quick buttons': 'तुरंत बटन', 'One tap starts these instantly, even offline. Minutes empty = until you start the next thing.': 'एक टैप में तुरंत शुरू, ऑफ़लाइन भी। मिनट खाली = अगली चीज़ शुरू होने तक।',
    '+ Add button': '+ बटन जोड़ें', Account: 'खाता', 'Download JSON': 'JSON डाउनलोड', 'Download CSV': 'CSV डाउनलोड',
    'Sign out': 'साइन आउट', 'Delete account': 'खाता हटाएँ', Name: 'नाम', Minutes: 'मिनट',
  },
};
