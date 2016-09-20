import React from 'react'
import Relay from 'react-relay'
import Redirect from 'react-router/Redirect'
import Link from 'react-router/Link'
import { StyleSheet, css } from 'aphrodite'
import { UpdatePostMutation, DeletePostMutation } from '../mutations'

class PostPage extends React.Component {
  static contextTypes = {
    user: React.PropTypes.object,
  }

  state = {
    clickedDelete: null,
  }

  handleUpdate = (event) => {
    const propName = event.target.dataset.prop
    const newValue = event.target.innerText
    const oldValue = this.props.post[propName]

    if (newValue === oldValue)
      return

    // PostGrahpQL expects the prop names of the
    // new values to be prefixed with `new`

    this.props.relay.commitUpdate(
      new UpdatePostMutation({
        post: this.props.post,
        newPost: {
          [`new${capitalizeFirstLetter(propName)}`]: newValue,
        },
      })
    )
  }

  handleDelete = (event) => {
    this.setState({ clickedDelete: true })

    // TODO: Use applyUpdate and commit once navigated?
    this.props.relay.commitUpdate(
      new DeletePostMutation({
        post: this.props.post,
        viewer: this.props.viewer,
      })
    )
  }

  // TODO: get rid of warnings
  // contenteditable is used here out of simplicity, for the moment
  // react complains; I chose to ignore it
  render() {
    const { post } = this.props
    const { token, personId } = this.context.user
    const authAndOwn = personId === post.authorId && !!token

    if (this.state.clickedDelete)
      return <Redirect to="/posts" />

    return (
      <div>
        <Link to="/posts">back to Posts</Link>
        <header>
          <h1 data-prop="headline" contentEditable={authAndOwn} onBlur={this.handleUpdate}>{post.headline}</h1>
          <p>by {post.author.fullName}</p>
        </header>
        <p data-prop="body" contentEditable={authAndOwn} onBlur={this.handleUpdate}>{post.body}</p>
        <aside>
          {authAndOwn &&
            <button onClick={this.handleDelete}>Delete Post</button>
          }
        </aside>
      </div>
    )
  }
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

export default Relay.createContainer(PostPage, {
  fragments: {
    viewer: () => Relay.QL`
      fragment on Viewer {
        ${DeletePostMutation.getFragment('viewer')}
      }
    `,
    post: () => Relay.QL`
      fragment on Post {
        ${UpdatePostMutation.getFragment('post')}
        ${DeletePostMutation.getFragment('post')}
        headline
        body
        authorId
        author: personByAuthorId {
          fullName
        }
      }
    `,
  },
})
