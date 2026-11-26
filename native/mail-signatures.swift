// Signaturen in Mails mit dem Sprachmodell auf dem Gerät finden (Apple Foundation Models, macOS 26+).
// Läuft als Hilfsprozess der App: eine Anfrage je Zeile auf stdin, eine Antwort je Zeile auf stdout.
//
//   → {"id":"1","parts":[{"first":1,"lines":["Hallo Kim,","…"]}]}
//   ← {"id":"1","starts":[5]}        Nummer der ersten Signaturzeile je Teil, null wenn keine
//
// Beim Start meldet er {"ready":true,"available":true|false,"reason":"…"}.
// Die Mail verlässt das Gerät nicht.
import Foundation
import FoundationModels

@Generable
struct SignatureAnswer {
  @Guide(description: "Nummer der ersten Zeile, die zur Signatur gehört. 0, wenn die Nachricht keine Signatur hat.")
  var signatureStartLine: Int
}

struct Part: Decodable {
  let first: Int
  let lines: [String]
}

struct Request: Decodable {
  let id: String
  let parts: [Part]
}

struct Response: Encodable {
  let id: String
  let starts: [Int?]?
  let error: String?
}

struct Hello: Encodable {
  let ready: Bool
  let available: Bool
  let reason: String?
}

let instructions = """
  Du bekommst eine einzelne E-Mail-Nachricht als nummerierte Zeilen. Finde die erste Zeile ihrer Signatur.
  Zur Signatur gehören: Position oder Titel, Firma, Abteilung, Anschrift, Telefon, Fax, Mobil, E-Mail-Adressen, \
  Webseiten, Social-Media-Links, Bilder und Logos, Registerangaben (Amtsgericht, HRB, Geschäftsführer, Vorstand, \
  USt-IdNr.) und Hinweise zu Vertraulichkeit, Datenschutz oder Umwelt.
  Nicht zur Signatur gehören: der eigentliche Text der Nachricht, Fragen, Bitten, Termine, Aufzählungen, \
  die Grußformel (etwa „Viele Grüße“ oder „Best regards“) und der Name direkt unter der Grußformel.
  Antworte mit der Nummer der ersten Signaturzeile. Hat die Nachricht keine Signatur, antworte mit 0.
  """

let encoder = JSONEncoder()

func emit<T: Encodable>(_ value: T) {
  guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return }
  print(text)
  fflush(stdout)
}

@main
struct MailSignatures {
  static func main() async {
    let model = SystemLanguageModel.default
    var available = false
    var reason: String?
    switch model.availability {
    case .available:
      available = true
    case .unavailable(let why):
      reason = String(describing: why)
    }
    // Modell schon beim Start laden: Die erste Antwort dauert sonst etwa drei Sekunden länger
    let warm = LanguageModelSession(instructions: instructions)
    if available { warm.prewarm() }
    emit(Hello(ready: true, available: available, reason: reason))

    while let line = readLine() {
      guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else { continue }
      guard available else {
        emit(Response(id: request.id, starts: nil, error: reason ?? "unavailable"))
        continue
      }
      var starts: [Int?] = []
      for part in request.parts {
        let last = part.first + part.lines.count - 1
        let numbered = part.lines.enumerated().map { "\(part.first + $0.offset) \($0.element)" }.joined(separator: "\n")
        do {
          // Eigene Sitzung je Teil: Der Verlauf soll keine Antwort beeinflussen
          let session = LanguageModelSession(instructions: instructions)
          let answer = try await session.respond(to: numbered, generating: SignatureAnswer.self)
          let n = answer.content.signatureStartLine
          starts.append(n >= part.first && n <= last ? n : nil)
        } catch {
          starts.append(nil)
        }
      }
      emit(Response(id: request.id, starts: starts, error: nil))
    }
  }
}
