package com.voicekhata.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/** Short, foreground-only 16 kHz PCM capture for an explicit assistant gesture. */
class AudioRecorder(private val context: Context) {
    companion object {
        private const val LOG_TAG = "VoiceKhataAudio"
        private const val SAMPLE_RATE = 16_000
        private const val MAX_DURATION_MS = 20_000L
        private const val SILENCE_DURATION_MS = 1_500L
        private const val SPEECH_RMS_THRESHOLD = 550.0
    }

    fun interface Callback {
        fun onComplete(wav: ByteArray?, error: String?)
    }

    private val cancelled = AtomicBoolean(false)
    private val stopRequested = AtomicBoolean(false)
    @Volatile private var activeRecord: AudioRecord? = null

    fun start(onComplete: Callback) {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            onComplete.onComplete(null, "Allow microphone access in VoiceKhata settings, then try again.")
            return
        }
        if (activeRecord != null) return
        cancelled.set(false)
        stopRequested.set(false)
        Log.i(LOG_TAG, "Capture requested; microphone permission is available.")
        Thread({ capture(onComplete) }, "voicekhata-audio-capture").start()
    }

    fun finish() {
        stopRequested.set(true)
    }

    fun cancel() {
        cancelled.set(true)
        try { activeRecord?.stop() } catch (_: IllegalStateException) { }
    }

    private fun capture(onComplete: Callback) {
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuffer <= 0) {
            onComplete.onComplete(null, "This phone could not start microphone recording.")
            return
        }

        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuffer, SAMPLE_RATE / 2)
            )
        } catch (_: SecurityException) {
            onComplete.onComplete(null, "Microphone permission is required to record a voice entry.")
            return
        } catch (_: IllegalArgumentException) {
            onComplete.onComplete(null, "This phone does not support the requested audio format.")
            return
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            onComplete.onComplete(null, "This phone could not initialize its microphone.")
            return
        }

        activeRecord = recorder
        // Use the phone's available voice DSP for echo cancellation, noise
        // suppression and level control. Unsupported effects are optional.
        val audioEffects = listOfNotNull(
            if (AcousticEchoCanceler.isAvailable()) runCatching {
                AcousticEchoCanceler.create(recorder.audioSessionId)?.apply { enabled = true }
            }.getOrNull() else null,
            if (NoiseSuppressor.isAvailable()) runCatching {
                NoiseSuppressor.create(recorder.audioSessionId)?.apply { enabled = true }
            }.getOrNull() else null,
            if (AutomaticGainControl.isAvailable()) runCatching {
                AutomaticGainControl.create(recorder.audioSessionId)?.apply { enabled = true }
            }.getOrNull() else null,
        )
        val pcm = ByteArrayOutputStream()
        val samples = ShortArray(1_024)
        var heardSpeech = false
        var silenceStartedAt = 0L
        val startedAt = SystemClock.elapsedRealtime()
        try {
            recorder.startRecording()
            Log.i(LOG_TAG, "AudioRecord started at 16 kHz mono PCM.")
            while (!cancelled.get() && !stopRequested.get() && SystemClock.elapsedRealtime() - startedAt < MAX_DURATION_MS) {
                val count = recorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                if (count < 0) throw IOException("Microphone read failed ($count)")
                if (count == 0) continue

                var sumSquares = 0.0
                for (i in 0 until count) {
                    val sample = samples[i].toInt()
                    sumSquares += sample * sample.toDouble()
                    pcm.write(sample and 0xff)
                    pcm.write((sample ushr 8) and 0xff)
                }

                val now = SystemClock.elapsedRealtime()
                val rms = sqrt(sumSquares / count)
                if (rms >= SPEECH_RMS_THRESHOLD) {
                    heardSpeech = true
                    silenceStartedAt = 0L
                } else if (heardSpeech) {
                    if (silenceStartedAt == 0L) silenceStartedAt = now
                    else if (now - silenceStartedAt >= SILENCE_DURATION_MS) break
                }
            }

            if (cancelled.get()) {
                Log.i(LOG_TAG, "Capture cancelled by user.")
                onComplete.onComplete(null, null)
            } else if (pcm.size() < SAMPLE_RATE / 2) {
                Log.w(LOG_TAG, "Capture ended without enough audio; speechDetected=$heardSpeech, pcmBytes=${pcm.size()}.")
                onComplete.onComplete(null, "I did not catch any speech. Please try again.")
            } else {
                Log.i(LOG_TAG, "Capture complete; speechDetected=$heardSpeech, pcmBytes=${pcm.size()}.")
                onComplete.onComplete(makeWav(pcm.toByteArray()), null)
            }
        } catch (_: SecurityException) {
            if (!cancelled.get()) onComplete.onComplete(null, "Microphone access was interrupted. Please try again.")
        } catch (error: IOException) {
            if (!cancelled.get()) onComplete.onComplete(null, error.message ?: "Recording stopped unexpectedly.")
        } finally {
            try { recorder.stop() } catch (_: IllegalStateException) { }
            audioEffects.forEach { effect -> runCatching { effect.release() } }
            recorder.release()
            activeRecord = null
        }
    }

    private fun makeWav(pcm: ByteArray): ByteArray {
        val output = ByteArrayOutputStream(pcm.size + 44)
        val data = DataOutputStream(output)
        data.writeBytes("RIFF")
        writeIntLe(data, pcm.size + 36)
        data.writeBytes("WAVE")
        data.writeBytes("fmt ")
        writeIntLe(data, 16)
        writeShortLe(data, 1)
        writeShortLe(data, 1)
        writeIntLe(data, SAMPLE_RATE)
        writeIntLe(data, SAMPLE_RATE * 2)
        writeShortLe(data, 2)
        writeShortLe(data, 16)
        data.writeBytes("data")
        writeIntLe(data, pcm.size)
        data.write(pcm)
        data.flush()
        return output.toByteArray()
    }

    private fun writeShortLe(out: DataOutputStream, value: Int) {
        out.writeByte(value and 0xff)
        out.writeByte((value ushr 8) and 0xff)
    }

    private fun writeIntLe(out: DataOutputStream, value: Int) {
        out.writeByte(value and 0xff)
        out.writeByte((value ushr 8) and 0xff)
        out.writeByte((value ushr 16) and 0xff)
        out.writeByte((value ushr 24) and 0xff)
    }
}
